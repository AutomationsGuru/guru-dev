import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";
import { createBaseTools } from "../../src/tools/builtins/baseToolFactory.js";
import { createPiBashTool } from "../../src/tools/builtins/bashTool.js";

describe("base tools", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "guruharness-pibase-"));
  });

  afterEach(async () => {
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
    const registry = createToolRegistry(createBaseTools({ bash: { shellAllowlist: ["node"], executor: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }) } }));
    const observation = await executeRegisteredTool(registry, "bash", { repoRoot, command: "node", args: ["script.js"], dryRun: false });
    expect(observation.output).toMatchObject({ executed: true, exitCode: 0, stdout: "ok" });
  });
});

describe("bash full-command-line handling (shakedown fixes)", () => {
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

describe("parity tools (askQuestion, searchWeb, readUrl)", () => {
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

  it("should fail ask_question when callback is missing and stdin is non-TTY", async () => {
    // Vitest runs non-TTY, so the default TTY prompt path is skipped and we
    // still get the clean "not supported" failure for headless/RPC callers.
    const registry = createToolRegistry(createBaseTools());
    const obs = await executeRegisteredTool(registry, "ask_question", {
      questions: [{ question: "A?", options: ["A", "B"] }]
    });
    expect(obs.status).toBe("failed");
    expect(obs.error).toContain("not supported");
  });

  it("should refuse default TTY prompt when allowDefaultTtyPrompt is false", async () => {
    const registry = createToolRegistry(
      createBaseTools({ askQuestion: { allowDefaultTtyPrompt: false } })
    );
    const obs = await executeRegisteredTool(registry, "ask_question", {
      questions: [{ question: "A?", options: ["A", "B"] }]
    });
    expect(obs.status).toBe("failed");
    expect(obs.error).toContain("not supported");
  });

  it("should execute search_web when callback is provided", async () => {
    const registry = createToolRegistry(createBaseTools({
      searchWeb: {
        onSearch: async (q) => [{ title: "T", url: "U", snippet: q }]
      }
    }));

    const obs = await executeRegisteredTool(registry, "search_web", { query: "hello" });
    expect(obs.status).toBe("succeeded");
    expect(obs.output).toMatchObject({ results: [{ title: "T", url: "U", snippet: "hello" }] });
  });

  it("should execute read_url_content when callback is provided", async () => {
    const registry = createToolRegistry(createBaseTools({
      readUrl: {
        onFetch: async (u) => `content from ${u}`
      }
    }));

    const obs = await executeRegisteredTool(registry, "read_url_content", { url: "http://example.com" });
    expect(obs.status).toBe("succeeded");
    expect(obs.output).toMatchObject({ content: "content from http://example.com" });
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
