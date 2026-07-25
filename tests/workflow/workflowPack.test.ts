import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowPackSchema } from "../../src/workflow/schema.js";
import { loadPacks, resolvePack, validatePack, validatePackData } from "../../src/workflow/validate.js";
import {
  expandPackParams,
  extractJsonObject,
  runPack,
  validateAgainstJsonSchema,
  type WorkflowPackSessionFactory
} from "../../src/workflow/runPack.js";
import type { CommandExecutor } from "../../src/review/gates.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  const dir = join(tmpdir(), `workflow-pack-test-${process.pid}-${dirs.length}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function writePack(directory: string, name: string, data: unknown): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data), "utf8");
  return path;
}

const validPack = {
  schemaVersion: 1,
  id: "repo-tidy",
  title: "Tidy the repo",
  instructions: "Clean up {{scope}} and report what changed.",
  prompt: "Start tidying {{scope}}.",
  parameters: [
    { name: "scope", required: true },
    { name: "level", default: "light" }
  ],
  tools: ["read", "grep"],
  checks: [{ command: ["node", "--version"] }],
  max_retries: 1
} as const;

/** Stub executor: exit 0 with empty output, or scripted by command join. */
const passingExecutor: CommandExecutor = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 1
});

function scriptedExecutor(script: (command: readonly string[], call: number) => { exitCode: number; stdout?: string }): CommandExecutor {
  let call = 0;
  return async (command) => {
    call += 1;
    const outcome = script(command, call);
    return { exitCode: outcome.exitCode, stdout: outcome.stdout ?? "", stderr: "", durationMs: 1 };
  };
}

function stubSessionFactory(outputs: readonly string[]): { factory: WorkflowPackSessionFactory; prompts: string[]; setups: { toolAllowlist?: readonly string[]; model?: string }[] } {
  const prompts: string[] = [];
  const setups: { toolAllowlist?: readonly string[]; model?: string }[] = [];
  let attempt = 0;
  const factory: WorkflowPackSessionFactory = (setup) => {
    setups.push({ toolAllowlist: setup.toolAllowlist, model: setup.model });
    const queue = [...outputs.slice(attempt)];
    attempt += 1;
    let index = 0;
    return {
      prompt: async (text: string) => {
        prompts.push(text);
        const content = queue[Math.min(index, queue.length - 1)] ?? "";
        index += 1;
        return { content };
      }
    };
  };
  return { factory, prompts, setups };
}

describe("WorkflowPackSchema", () => {
  it("accepts a valid pack", () => {
    const parsed = WorkflowPackSchema.safeParse(validPack);
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown fields and bad ids", () => {
    expect(WorkflowPackSchema.safeParse({ ...validPack, surprise: true }).success).toBe(false);
    expect(WorkflowPackSchema.safeParse({ ...validPack, id: "Not Ok!" }).success).toBe(false);
    expect(WorkflowPackSchema.safeParse({ ...validPack, instructions: "" }).success).toBe(false);
    expect(WorkflowPackSchema.safeParse({ ...validPack, max_retries: 99 }).success).toBe(false);
    expect(WorkflowPackSchema.safeParse({ ...validPack, checks: [{ command: [] }] }).success).toBe(false);
  });

  it("validatePackData reports field paths", () => {
    const result = validatePackData({ schemaVersion: 1, id: "x", title: "t", instructions: "i", checks: [{ command: [] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.path.startsWith("checks"))).toBe(true);
    }
  });
});

describe("validatePack / loadPacks", () => {
  it("loads home packs and reports invalid files without throwing", () => {
    const home = makeTmpDir();
    const packsDir = join(home, "packs");
    writePack(packsDir, "good.pack.json", validPack);
    writePack(packsDir, "bad.pack.json", { schemaVersion: 1, id: "bad" });
    writePack(packsDir, "broken.pack.json", "{ not json");

    const report = loadPacks({ homeDirectory: home });
    expect(report.packs.map((loaded) => loaded.pack.id)).toEqual(["repo-tidy"]);
    expect(report.invalid).toHaveLength(2);
    expect(report.rejectedProjectOverrides).toHaveLength(0);
  });

  it("project pack with the same id overrides home when it tightens tools", () => {
    const home = makeTmpDir();
    const project = makeTmpDir();
    writePack(join(home, "packs"), "repo-tidy.pack.json", validPack);
    writePack(join(project, ".guru", "packs"), "repo-tidy.pack.json", { ...validPack, tools: ["read"], title: "Tighter" });

    const report = loadPacks({ homeDirectory: home, projectRoot: project });
    expect(report.packs).toHaveLength(1);
    expect(report.packs[0]?.source).toBe("project");
    expect(report.packs[0]?.pack.tools).toEqual(["read"]);
    expect(report.packs[0]?.pack.title).toBe("Tighter");
    expect(report.rejectedProjectOverrides).toHaveLength(0);
  });

  it("rejects a project pack that LOOSENS the home tool allowlist and keeps home", () => {
    const home = makeTmpDir();
    const project = makeTmpDir();
    writePack(join(home, "packs"), "repo-tidy.pack.json", validPack);
    // Home allows [read, grep]; project adds "bash" — loosening.
    writePack(join(project, ".guru", "packs"), "repo-tidy.pack.json", { ...validPack, tools: ["read", "grep", "bash"] });
    // Dropping the allowlist entirely is also loosening.
    writePack(join(project, ".guru", "packs"), "other.pack.json", (() => {
      const { tools: _tools, ...rest } = validPack;
      return { ...rest, id: "other" };
    })());

    const report = loadPacks({ homeDirectory: home, projectRoot: project });
    expect(report.rejectedProjectOverrides).toHaveLength(1);
    expect(report.rejectedProjectOverrides[0]?.id).toBe("repo-tidy");
    const effective = resolvePack("repo-tidy", { homeDirectory: home, projectRoot: project });
    expect(effective?.source).toBe("home");
    expect(effective?.pack.tools).toEqual(["read", "grep"]);
    // A project-only pack with no home counterpart is allowed (nothing to loosen).
    expect(resolvePack("other", { homeDirectory: home, projectRoot: project })?.source).toBe("project");
  });

  it("validatePack reports unreadable files as errors", () => {
    const result = validatePack(join(makeTmpDir(), "missing.pack.json"));
    expect(result.ok).toBe(false);
  });
});

describe("expandPackParams", () => {
  it("expands supplied params and defaults, reports missing required", () => {
    const pack = WorkflowPackSchema.parse(validPack);
    const expanded = expandPackParams(pack, { scope: "tests" });
    expect(expanded.instructions).toBe("Clean up tests and report what changed.");
    expect(expanded.prompt).toBe("Start tidying tests.");
    expect(expanded.missing).toEqual([]);

    const missing = expandPackParams(pack, {});
    expect(missing.missing).toEqual(["scope"]);
  });

  it("never re-expands placeholder values injected via params", () => {
    const pack = WorkflowPackSchema.parse({
      schemaVersion: 1,
      id: "literal",
      title: "t",
      instructions: "a {{x}} b",
      parameters: [{ name: "x", required: true }, { name: "y" }]
    });
    const expanded = expandPackParams(pack, { x: "{{y}}", y: "boom" });
    expect(expanded.instructions).toBe("a {{y}} b");
  });
});

describe("runPack", () => {
  it("refuses to run an invalid pack", async () => {
    const { factory } = stubSessionFactory(["done"]);
    const result = await runPack({ schemaVersion: 1, id: "bad" }, { createSession: factory, executeCheck: passingExecutor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid pack");
  });

  it("fails closed when a required parameter is missing (no session created)", async () => {
    const { factory, setups } = stubSessionFactory(["done"]);
    const result = await runPack(validPack, { createSession: factory, executeCheck: passingExecutor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing required parameters: scope");
    expect(setups).toHaveLength(0);
  });

  it("passes the pack allowlists and model pin to the session factory", async () => {
    const { factory, setups } = stubSessionFactory(["tidied"]);
    const pack = { ...validPack, model: "stub/model-x" };
    const result = await runPack(pack, { params: { scope: "src" }, createSession: factory, executeCheck: passingExecutor });
    expect(result.ok).toBe(true);
    expect(setups[0]?.toolAllowlist).toEqual(["read", "grep"]);
    expect(setups[0]?.model).toBe("stub/model-x");
  });

  it("fails the attempt when a check fails and retries up to max_retries", async () => {
    const { factory } = stubSessionFactory(["first", "second"]);
    const executor = scriptedExecutor((_command, call) => ({ exitCode: call === 1 ? 1 : 0 }));
    const result = await runPack(validPack, { params: { scope: "src" }, createSession: factory, executeCheck: executor });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.output).toBe("second");
    }
  });

  it("fails closed when checks keep failing past max_retries", async () => {
    const { factory } = stubSessionFactory(["a", "b"]);
    const executor = scriptedExecutor(() => ({ exitCode: 3 }));
    const result = await runPack(validPack, { params: { scope: "src" }, createSession: factory, executeCheck: executor });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(2); // 1 + max_retries(1), no unbounded loop
      expect(result.reason).toContain("outcome checks failed");
    }
  });

  it("honors check expectations on stdout content", async () => {
    const pack = {
      schemaVersion: 1,
      id: "expect-stdout",
      title: "t",
      instructions: "i",
      checks: [{ command: ["tool"], expect: { stdoutContains: "READY" } }]
    };
    const { factory } = stubSessionFactory(["done"]);
    const failing = await runPack(pack, {
      createSession: factory,
      executeCheck: scriptedExecutor(() => ({ exitCode: 0, stdout: "not ready" }))
    });
    expect(failing.ok).toBe(false);

    const { factory: factory2 } = stubSessionFactory(["done"]);
    const passing = await runPack(pack, {
      createSession: factory2,
      executeCheck: scriptedExecutor(() => ({ exitCode: 0, stdout: "READY now" }))
    });
    expect(passing.ok).toBe(true);
  });

  it("validates the final output against responseJsonSchema (single round-trip then fail closed)", async () => {
    const pack = {
      schemaVersion: 1,
      id: "structured",
      title: "t",
      instructions: "i",
      responseJsonSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false
      }
    };
    // First reply is prose; the correction round-trip returns valid JSON.
    const { factory, prompts } = stubSessionFactory(["Here is your summary.", '{"summary":"ok"}']);
    const result = await runPack(pack, { createSession: factory, executeCheck: passingExecutor });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.structured).toEqual({ summary: "ok" });
      expect(result.output).toBe('{"summary":"ok"}');
    }
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("failed validation");
  });

  it("fails closed when the structured correction also violates the schema", async () => {
    const pack = {
      schemaVersion: 1,
      id: "structured-fail",
      title: "t",
      instructions: "i",
      responseJsonSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }
    };
    const { factory } = stubSessionFactory(["no json at all", '{"n":"not an integer"}']);
    const result = await runPack(pack, { createSession: factory, executeCheck: passingExecutor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("responseJsonSchema not satisfied");
  });

  it("runs checks after the schema gate and returns structured output only when both pass", async () => {
    const pack = {
      schemaVersion: 1,
      id: "structured-checks",
      title: "t",
      instructions: "i",
      responseJsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      checks: [{ command: ["verify"] }]
    };
    const { factory } = stubSessionFactory(['{"ok":true}']);
    const result = await runPack(pack, { createSession: factory, executeCheck: passingExecutor });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.structured).toEqual({ ok: true });
      expect(result.checks).toHaveLength(1);
    }
  });
});

describe("validateAgainstJsonSchema / extractJsonObject", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
    required: ["name"],
    additionalProperties: false
  };

  it("accepts conforming values and rejects violations with paths", () => {
    expect(validateAgainstJsonSchema({ name: "x", tags: ["a"] }, schema)).toBeNull();
    expect(validateAgainstJsonSchema({ tags: [] }, schema)).toContain('missing required property "name"');
    expect(validateAgainstJsonSchema({ name: 1 }, schema)).toContain("$.name");
    expect(validateAgainstJsonSchema({ name: "x", extra: true }, schema)).toContain("additional properties");
    expect(validateAgainstJsonSchema({ name: "x", tags: [1] }, schema)).toContain("$.tags[0]");
  });

  it("extracts JSON from strict, fenced, and embedded replies", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject("```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(extractJsonObject('Sure! {"a":3} done')).toEqual({ a: 3 });
    expect(extractJsonObject("[1,2]")).toEqual([1, 2]);
    expect(extractJsonObject("no json here")).toBeUndefined();
  });
});
