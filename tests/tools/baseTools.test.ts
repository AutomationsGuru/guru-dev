import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";
import { createBaseTools } from "../../src/tools/builtins/baseToolFactory.js";
import { createPiBashTool } from "../../src/tools/builtins/bashTool.js";
import { resetBackgroundTasks } from "../../src/tools/builtins/backgroundTaskRegistry.js";

describe("base tools", () => {
  let repoRoot: string;

  beforeEach(async () => {
    resetBackgroundTasks();
    repoRoot = await mkdtemp(join(tmpdir(), "guruharness-pibase-"));
  });

  afterEach(async () => {
    resetBackgroundTasks();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("should read with offset and limit", async () => {
    await writeFile(join(repoRoot, "sample.txt"), "abcdef", "utf8");
    const registry = createToolRegistry(createBaseTools());
    const observation = await executeRegisteredTool(registry, "read", { repoRoot, path: "sample.txt", offset: 2, limit: 3 });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ contents: "cde", bytesRead: 3, truncated: true });
  });

  it("keeps UTF-8 code points intact when a byte window ends mid-character", async () => {
    await writeFile(join(repoRoot, "unicode.txt"), "A😀B", "utf8");
    const registry = createToolRegistry(createBaseTools());
    const observation = await executeRegisteredTool(registry, "read", {
      repoRoot,
      path: "unicode.txt",
      offset: 0,
      limit: 2
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({
      contents: "A😀",
      bytesRead: 5,
      nextOffset: 5,
      truncated: true
    });
    expect((observation.output as { contents?: string }).contents).not.toContain("�");
  });

  it("recovers the whole UTF-8 code point when an offset starts mid-character", async () => {
    await writeFile(join(repoRoot, "unicode-offset.txt"), "A😀B", "utf8");
    const registry = createToolRegistry(createBaseTools());
    const observation = await executeRegisteredTool(registry, "read", {
      repoRoot,
      path: "unicode-offset.txt",
      offset: 2,
      limit: 2
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ contents: "😀", bytesRead: 4, nextOffset: 5 });
    expect((observation.output as { contents?: string }).contents).not.toContain("�");
  });

  it("should write with dry-run default and apply when requested", async () => {
    const registry = createToolRegistry(createBaseTools({ write: { riskyPathPatterns: [".env"], secretAllowList: [] } }));
    const dryRun = await executeRegisteredTool(registry, "write", { repoRoot, path: "nested/out.txt", contents: "hello" });
    expect(dryRun.output).toMatchObject({ applied: false, dryRun: true });

    const applied = await executeRegisteredTool(registry, "write", { repoRoot, path: "nested/out.txt", contents: "hello", dryRun: false });
    expect(applied.output).toMatchObject({ applied: true, dryRun: false });
    await expect(readFile(join(repoRoot, "nested", "out.txt"), "utf8")).resolves.toBe("hello");
  });

  it("should enforce exact edit uniqueness", async () => {
    await writeFile(join(repoRoot, "edit.txt"), "one two one", "utf8");
    const registry = createToolRegistry(createBaseTools({ edit: { riskyPathPatterns: [], secretAllowList: [] } }));
    const blocked = await executeRegisteredTool(registry, "edit", { repoRoot, path: "edit.txt", oldText: "one", newText: "three" });
    expect(blocked.output).toMatchObject({ applied: false, replacements: 0 });

    const applied = await executeRegisteredTool(registry, "edit", { repoRoot, path: "edit.txt", oldText: "one", newText: "three", replaceAll: true, dryRun: false });
    expect(applied.output).toMatchObject({ applied: true, replacements: 2 });
  });

  it("should run bash through an injected executor", async () => {
    let backgroundStarts = 0;
    const registry = createToolRegistry(createBaseTools({
      bash: {
        shellAllowlist: ["node"],
        executor: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }),
        startBackground: () => {
          backgroundStarts += 1;
          return "unexpected";
        }
      }
    }));
    const observation = await executeRegisteredTool(registry, "bash", { repoRoot, command: "node", args: ["script.js"], dryRun: false });
    expect(observation.output).toMatchObject({ executed: true, background: false, exitCode: 0, stdout: "ok" });
    expect(backgroundStarts).toBe(0);
  });

  it("starts a background bash task that the default manage_task tool can list and inspect", async () => {
    const registry = createToolRegistry(createBaseTools({ bash: { shellAllowlist: [process.execPath] } }));
    const launched = await executeRegisteredTool(registry, "bash", {
      repoRoot,
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      background: true,
      dryRun: false
    });
    const launchOutput = launched.output as {
      readonly executed?: boolean;
      readonly background?: boolean;
      readonly taskId?: string;
      readonly command?: readonly string[];
      readonly exitCode?: number | null;
      readonly stdout?: string;
      readonly stderr?: string;
    };

    expect(launched.status).toBe("succeeded");
    expect(launchOutput).toMatchObject({
      executed: true,
      background: true,
      taskId: expect.stringMatching(/^task-/u),
      command: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"]
    });
    expect(launchOutput).not.toHaveProperty("exitCode");
    expect(launchOutput).not.toHaveProperty("stdout");
    expect(launchOutput).not.toHaveProperty("stderr");

    const listed = await executeRegisteredTool(registry, "manage_task", { Action: "list" });
    const list = (listed.output as { result: readonly { id: string }[] }).result;
    expect(list).toHaveLength(1);
    expect(list.some((task) => task.id === launchOutput.taskId)).toBe(true);

    const status = await executeRegisteredTool(registry, "manage_task", { Action: "status", TaskId: launchOutput.taskId });
    expect(status.output).toMatchObject({ result: { id: launchOutput.taskId, state: "running" } });
    await executeRegisteredTool(registry, "manage_task", { Action: "kill", TaskId: launchOutput.taskId });
  });
});

describe("bash full-command-line handling (shakedown fixes)", () => {
  it("launches the quote-aware normalized argv through the injected background starter only", async () => {
    const backgroundCalls: Array<{ readonly command: readonly string[]; readonly cwd: string }> = [];
    let foregroundCalls = 0;
    const tool = createPiBashTool({
      shellAllowlist: ["node"],
      executor: async () => {
        foregroundCalls += 1;
        return { exitCode: 0, stdout: "unexpected", stderr: "", durationMs: 1 };
      },
      startBackground: (command, cwd) => {
        backgroundCalls.push({ command: [...command], cwd });
        return "task-test";
      }
    });

    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: 'node -e "console.log(1)"',
      args: [],
      background: true,
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(backgroundCalls).toEqual([{ command: ["node", "-e", "console.log(1)"], cwd: process.cwd() }]);
    expect(foregroundCalls).toBe(0);
    expect(output).toMatchObject({
      executed: true,
      dryRun: false,
      background: true,
      command: ["node", "-e", "console.log(1)"],
      taskId: "task-test",
      blockers: []
    });
    expect(output).not.toHaveProperty("exitCode");
    expect(output).not.toHaveProperty("stdout");
    expect(output).not.toHaveProperty("stderr");
    expect(output).not.toHaveProperty("durationMs");
  });

  it("applies every foreground pre-execution policy before a background start", async () => {
    let backgroundStarts = 0;
    const tool = createPiBashTool({
      shellAllowlist: ["node"],
      startBackground: () => {
        backgroundStarts += 1;
        return "must-not-start";
      }
    });
    const registry = createToolRegistry([tool]);
    const cases: readonly Record<string, unknown>[] = [
      { repoRoot: process.cwd(), command: "curl https://example.com", background: true, dryRun: false },
      { repoRoot: process.cwd(), command: "node -e ok", background: true, dryRun: true },
      { repoRoot: process.cwd(), command: "node -e ok", cwd: "..", background: true, dryRun: false },
      { repoRoot: process.cwd(), command: "node", args: ["TOKEN=secret-value"], background: true, dryRun: false },
      { repoRoot: process.cwd(), command: "node -e ok && node -e bypass", background: true, dryRun: false }
    ];

    for (const input of cases) {
      const observation = await executeRegisteredTool(registry, "bash", input);
      expect(observation.status).toBe("succeeded");
      expect(observation.output).toMatchObject({ executed: false, background: true });
    }
    expect(backgroundStarts).toBe(0);
  });

  it("parses the same argv for foreground and background modes", async () => {
    let foregroundArgv: readonly string[] = [];
    let backgroundArgv: readonly string[] = [];
    const tool = createPiBashTool({
      shellAllowlist: ["node"],
      executor: async (command) => {
        foregroundArgv = [...command];
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
      },
      startBackground: (command) => {
        backgroundArgv = [...command];
        return "task-parity";
      }
    });
    const shared = {
      repoRoot: process.cwd(),
      command: 'node -e "console.log(1)"',
      args: [] as string[],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    };

    await tool.execute({ ...shared, background: false }, {});
    await tool.execute({ ...shared, background: true }, {});

    expect(backgroundArgv).toEqual(foregroundArgv);
    expect(foregroundArgv).toEqual(["node", "-e", "console.log(1)"]);
  });

  it("splits a full command line into argv when args are omitted", async () => {
    let seen: readonly string[] = [];
    const tool = createPiBashTool({
      shellAllowlist: ["npm"],
      executor: async (command, _context) => {
        seen = command;
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "npm test",
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(seen).toEqual(["npm", "test"]);
    expect(output.executed).toBe(true);
  });

  it("keeps quoted arguments together when splitting", async () => {
    let seen: readonly string[] = [];
    const tool = createPiBashTool({
      shellAllowlist: ["git"],
      executor: async (command, _context) => {
        seen = command;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 5 };
      }
    });
    await tool.execute({
      repoRoot: process.cwd(),
      command: 'git commit -m "two words"',
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(seen).toEqual(["git", "commit", "-m", "two words"]);
  });

  it("still blocks non-allowlisted executables after splitting", async () => {
    const tool = createPiBashTool({ shellAllowlist: ["npm"] });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "curl http://example.com",
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(output.executed).toBe(false);
    expect(output.blockers.some((blocker) => blocker.includes("allowlisted"))).toBe(true);
  });

  it("allows any executable when the runtime policy uses the YOLO wildcard", async () => {
    let seen: readonly string[] = [];
    const tool = createPiBashTool({
      shellAllowlist: ["*"],
      executor: async (command) => {
        seen = command;
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "rg --version",
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(output.executed).toBe(true);
    expect(seen).toEqual(["rg", "--version"]);
  });

  it("rejects shell operators instead of passing them as literal argv", async () => {
    let calls = 0;
    const tool = createPiBashTool({
      shellAllowlist: ["npm"],
      executor: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "unexpected", stderr: "", durationMs: 1 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "npm run typecheck && npm test",
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(calls).toBe(0);
    expect(output.executed).toBe(false);
    expect(output.blockers).toContain(
      "Shell operators are not supported by the argv command runner; issue each command as a separate tool call."
    );
  });

  it("rejects shell operators supplied through explicit args", async () => {
    let calls = 0;
    const tool = createPiBashTool({
      shellAllowlist: ["npm"],
      executor: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "unexpected", stderr: "", durationMs: 1 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "npm",
      args: ["test", "&", "echo", "unexpected"],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(calls).toBe(0);
    expect(output.executed).toBe(false);
    expect(output.blockers).toContain(
      "Shell operators are not supported by the argv command runner; issue each command as a separate tool call."
    );
  });

  it.each(["a&b", "%PATH%", "!PATH!", "(echo)", "^oops"])("rejects cmd metasyntax in an explicit argument: %s", async (argument) => {
    let calls = 0;
    const tool = createPiBashTool({
      shellAllowlist: ["npm"],
      executor: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "unexpected", stderr: "", durationMs: 1 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "npm",
      args: ["test", argument],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(calls).toBe(0);
    expect(output.blockers).toContain(
      "Shell operators are not supported by the argv command runner; issue each command as a separate tool call."
    );
  });

  it("validates the final argv after stripping full-line quotes", async () => {
    let calls = 0;
    const tool = createPiBashTool({
      shellAllowlist: ["npm"],
      executor: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "unexpected", stderr: "", durationMs: 1 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: 'npm test "a&b"',
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(calls).toBe(0);
    expect(output.executed).toBe(false);
    expect(output.blockers).toContain(
      "Shell operators are not supported by the argv command runner; issue each command as a separate tool call."
    );
  });

  it("allows ordinary punctuation for native executables that do not need cmd.exe", async () => {
    let seen: readonly string[] = [];
    const tool = createPiBashTool({
      shellAllowlist: ["node"],
      executor: async (command) => {
        seen = command;
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "node",
      args: ["-e", "console.log('ok!')"],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(output.executed).toBe(true);
    expect(seen).toEqual(["node", "-e", "console.log('ok!')"]);
  });

  it("rejects an unterminated quoted argument instead of silently changing it", async () => {
    let calls = 0;
    const tool = createPiBashTool({
      shellAllowlist: ["git"],
      executor: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "unexpected", stderr: "", durationMs: 1 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: 'git commit -m "unfinished',
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(calls).toBe(0);
    expect(output.executed).toBe(false);
    expect(output.blockers).toContain(
      "Command line has an unterminated quote; correct the quoting and retry."
    );
  });
});

describe("parity tools (askQuestion)", () => {
  it("should execute ask_question when callback is provided", async () => {
    let asked = false;
    const registry = createToolRegistry(createBaseTools({
      askQuestion: {
        onAsk: async (questions) => {
          asked = true;
          return [["Option A"]];
        }
      }
    }));

    const obs = await executeRegisteredTool(registry, "ask_question", {
      questions: [{ question: "A or B?", options: ["Option A", "Option B"] }]
    });

    expect(obs.status).toBe("succeeded");
    expect(obs.output).toMatchObject({ answers: [["Option A"]] });
    expect(asked).toBe(true);
  });

  it("should answer headless (non-TTY, no onAsk) with interactive:false instead of hanging", async () => {
    // Vitest runs non-TTY, so the default TTY prompt path is skipped; headless
    // callers get a clean interactive:false result with empty answers.
    const registry = createToolRegistry(createBaseTools());
    const obs = await executeRegisteredTool(registry, "ask_question", {
      questions: [{ question: "A?", options: ["A", "B"] }]
    });
    expect(obs.status).toBe("succeeded");
    expect(obs.output).toMatchObject({ interactive: false, answers: [[]] });
  });

  it("should execute schedule tool when callback is provided", async () => {
    const registry = createToolRegistry(createBaseTools({
      schedule: {
        onSchedule: async (input) => `task-${input.DurationSeconds}`
      }
    }));

    const obs = await executeRegisteredTool(registry, "schedule", { Prompt: "Wait", DurationSeconds: "10" });
    expect(obs.status).toBe("succeeded");
    expect(obs.output).toMatchObject({ taskId: "task-10" });
  });

  it("should execute manage_task tool by default", async () => {
    const registry = createToolRegistry(createBaseTools());
    const obs = await executeRegisteredTool(registry, "manage_task", { Action: "list" });
    expect(obs.status).toBe("succeeded");
    expect(Array.isArray((obs.output as { result: unknown }).result)).toBe(true);
  });

  it("should execute manage_task tool when callback is provided", async () => {
    const registry = createToolRegistry(createBaseTools({
      manageTask: {
        onManage: async (action, taskId, input) => `${action} on ${taskId}`
      }
    }));

    const obs = await executeRegisteredTool(registry, "manage_task", { Action: "status", TaskId: "t1" });
    expect(obs.status).toBe("succeeded");
    expect(obs.output).toMatchObject({ result: "status on t1" });
  });
});
