import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLAN_BRANCH_SCHEMA_VERSION,
  PlanBranchCheckpointSchema,
  buildPlanBranchCheckpoint,
  createPlanBranchRecord,
  isValidPlanBranchName,
  normalizePlanBranchMessages,
  planBranchFileName,
  type PlanBranchConvoMessage,
  type PlanBranchPendingItem,
  type PlanBranchStateInput
} from '../../src/session/planBranch.js';
import { createPlanBranchStore } from '../../src/session/planBranchStore.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDirectory(): string {
  const directory = join(tmpdir(), `plan-branch-test-${process.pid}-${dirs.length}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  dirs.push(directory);
  return directory;
}

let tick = 0;
const now = (): Date => new Date(1_800_000_000_000 + tick++ * 1_000);

const MSG_USER: PlanBranchConvoMessage = { role: "user", content: "ship the fork feature" };
const MSG_ASSISTANT: PlanBranchConvoMessage = { role: "assistant", content: "forking plan state now" };
const MSG_TOOL: PlanBranchConvoMessage = { role: "tool", content: "read ok", toolCallId: "tc-1" };

const PENDING_A: PlanBranchPendingItem = { id: "p-1", kind: "steer", content: "prefer smallest diff" };
const PENDING_B: PlanBranchPendingItem = { id: "p-2", kind: "approval", content: "allow write src/x.ts" };

function stateInput(over: Partial<PlanBranchStateInput> = {}): PlanBranchStateInput {
  return {
    sessionId: "s-1",
    context: { objective: "add plan branches", activeFile: "src/session/planBranch.ts" },
    pending: [PENDING_A],
    convo: [MSG_USER, MSG_ASSISTANT],
    ...over
  };
}

function makeStore(directory: string) {
  return createPlanBranchStore({ directory, now });
}

describe("planBranch schema + helpers", () => {
  it("accepts well-formed names and rejects unsafe ones", () => {
    expect(isValidPlanBranchName("experiment-a")).toBe(true);
    expect(isValidPlanBranchName("a")).toBe(true);
    expect(isValidPlanBranchName("Under_score.9")).toBe(true);
    expect(isValidPlanBranchName("")).toBe(false);
    expect(isValidPlanBranchName("has space")).toBe(false);
    expect(isValidPlanBranchName("slash/inside")).toBe(false);
    expect(isValidPlanBranchName("..")).toBe(false);
    expect(isValidPlanBranchName("-leading")).toBe(false);
    expect(isValidPlanBranchName("trailing-")).toBe(false);
    expect(isValidPlanBranchName("semi;colon")).toBe(false);
  });

  it("maps branch names to safe per-branch file names", () => {
    expect(planBranchFileName("experiment-a")).toBe("experiment-a.json");
  });

  it("normalizes convo checkpoints (trim, drop empty, cap from the tail)", () => {
    const many = Array.from({ length: 220 }, (_, index) => ({ role: "user" as const, content: `m${index}` }));
    const normalized = normalizePlanBranchMessages([{ role: "user", content: "   " }, ...many]);
    expect(normalized).toHaveLength(200);
    expect(normalized.at(0)?.content).toBe("m20");
    expect(normalized.at(-1)?.content).toBe("m219");
  });

  it("builds a checkpoint that round-trips through the schema", () => {
    const checkpoint = buildPlanBranchCheckpoint(stateInput());
    expect(checkpoint.schemaVersion).toBe(PLAN_BRANCH_SCHEMA_VERSION);
    expect(PlanBranchCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
  });

  it("deep-copies checkpoint data so later caller mutation cannot bleed into it", () => {
    const input = stateInput();
    const checkpoint = buildPlanBranchCheckpoint(input);
    input.context["injected"] = true;
    (input.pending as PlanBranchPendingItem[]).push(PENDING_B);
    (input.convo as PlanBranchConvoMessage[]).push(MSG_TOOL);
    expect(checkpoint.context).not.toHaveProperty("injected");
    expect(checkpoint.pending).toHaveLength(1);
    expect(checkpoint.convo).toHaveLength(2);
  });

  it("creates branch records with the active flag only on the active branch", () => {
    const active = createPlanBranchRecord("alpha", stateInput(), { active: true, now });
    const inactive = createPlanBranchRecord("beta", stateInput(), { active: false, now });
    expect(active.active).toBe(true);
    expect(inactive.active).toBe(false);
    expect(active.name).toBe("alpha");
    expect(active.checkpoint.sessionId).toBe("s-1");
  });
});

describe("planBranchStore fork/switch/list/delete", () => {
  it("forks the mainline by default and makes the new branch active", () => {
    const store = makeStore(makeDirectory());
    const record = store.fork("alpha", stateInput());
    expect(record.name).toBe("alpha");
    expect(record.active).toBe(true);
    expect(store.current()).toBe("alpha");
    expect(store.mainlineRecord()).not.toBeNull();
    expect(store.mainlineRecord()?.active).toBe(false);
    const names = store.list().map((branch) => branch.name);
    expect(names).toEqual(["main", "alpha"]);
  });

  it("forks from a sibling branch without inheriting its later mutations", () => {
    const store = makeStore(makeDirectory());
    store.fork("alpha", stateInput({ context: { step: 1 }, pending: [PENDING_A], convo: [MSG_USER] }));
    const beta = store.fork("beta", stateInput({ context: { step: 2 }, pending: [PENDING_B], convo: [MSG_ASSISTANT] }), { from: "alpha" });
    expect(beta.source).toBe("alpha");
    expect(beta.checkpoint.context).toEqual({ step: 2 });
    expect(beta.checkpoint.pending).toEqual([PENDING_B]);
    // Mutating alpha later must not bleed into beta's checkpoint.
    store.switch("alpha");
    store.checkpoint(stateInput({ context: { step: 99 }, pending: [], convo: [] }));
    const reread = makeStore(store.directory);
    expect(reread.readCheckpoint("beta")?.context).toEqual({ step: 2 });
  });

  it("re-checkpoints the active branch in place", () => {
    const store = makeStore(makeDirectory());
    store.fork("alpha", stateInput());
    const updated = store.checkpoint(stateInput({ context: { objective: "v2" }, pending: [PENDING_A, PENDING_B] }));
    expect(updated.name).toBe("alpha");
    expect(updated.checkpoint.context).toEqual({ objective: "v2" });
    expect(updated.checkpoint.pending).toHaveLength(2);
  });

  it("switch activates exactly one branch and exposes its checkpoint for resume", () => {
    const store = makeStore(makeDirectory());
    store.fork("alpha", stateInput({ context: { branch: "alpha" }, convo: [MSG_USER] }));
    store.fork("beta", stateInput({ context: { branch: "beta" }, convo: [MSG_ASSISTANT] }));
    const target = store.switch("alpha");
    expect(target.active).toBe(true);
    expect(store.current()).toBe("alpha");
    // Resume injects the checkpoint for the now-active branch only.
    const resume = store.readCheckpoint();
    expect(resume?.context).toEqual({ branch: "alpha" });
    expect(resume?.convo).toEqual([MSG_USER]);
    const reread = makeStore(store.directory);
    const actives = reread.list().filter((branch) => branch.active);
    expect(actives.map((branch) => branch.name)).toEqual(["alpha"]);
  });

  it("switching back to main restores the mainline checkpoint (no sibling bleed)", () => {
    const store = makeStore(makeDirectory());
    store.fork("alpha", stateInput({ context: { main: true }, pending: [PENDING_A], convo: [MSG_USER] }));
    store.checkpoint(stateInput({ context: { alpha: true }, pending: [PENDING_B], convo: [MSG_ASSISTANT] }));
    const main = store.switch("main");
    expect(main.checkpoint.context).toEqual({ main: true });
    expect(main.checkpoint.pending).toEqual([PENDING_A]);
    expect(main.checkpoint.convo).toEqual([MSG_USER]);
    expect(store.readCheckpoint("alpha")?.context).toEqual({ alpha: true });
  });

  it("deletes a branch and falls back to main when the active branch is deleted", () => {
    const store = makeStore(makeDirectory());
    store.fork("alpha", stateInput());
    expect(store.current()).toBe("alpha");
    store.delete("alpha");
    expect(store.current()).toBe("main");
    expect(store.list().map((branch) => branch.name)).toEqual(["main"]);
    expect(store.readCheckpoint("alpha")).toBeNull();
  });

  it("refuses to delete the mainline and unknown branches", () => {
    const store = makeStore(makeDirectory());
    expect(() => store.delete("main")).toThrow(/mainline/i);
    expect(() => store.delete("ghost")).toThrow(/unknown plan branch/i);
  });

  it("rejects duplicate forks and invalid names", () => {
    const store = makeStore(makeDirectory());
    store.fork("alpha", stateInput());
    expect(() => store.fork("alpha", stateInput())).toThrow(/already exists/i);
    expect(() => store.fork("bad name", stateInput())).toThrow(/invalid plan branch name/i);
    expect(() => store.fork("../escape", stateInput())).toThrow(/invalid plan branch name/i);
  });

  it("throws on unknown switch/fork sources", () => {
    const store = makeStore(makeDirectory());
    expect(() => store.switch("ghost")).toThrow(/unknown plan branch/i);
    expect(() => store.fork("alpha", stateInput(), { from: "ghost" })).toThrow(/unknown plan branch/i);
  });

  it("validates checkpoint payloads on fork and checkpoint", () => {
    const store = makeStore(makeDirectory());
    expect(() => store.fork("alpha", stateInput({ sessionId: " " }))).toThrow(/sessionId/i);
    store.fork("alpha", stateInput());
    expect(() =>
      store.checkpoint(stateInput({ convo: [{ role: "ghost", content: "x" } as never] }))
    ).toThrow(/role/i);
  });

  it("skips corrupt branch files on read/list instead of crashing", () => {
    const directory = makeDirectory();
    const store = makeStore(directory);
    store.fork("alpha", stateInput());
    writeFileSync(join(directory, "alpha.json"), "{ not json", "utf8");
    writeFileSync(join(directory, "rogue.json"), JSON.stringify({ hello: "world" }), "utf8");
    const reread = makeStore(directory);
    expect(reread.readCheckpoint("alpha")).toBeNull();
    expect(reread.list().map((branch) => branch.name)).toEqual(["main"]);
    expect(existsSync(join(directory, "main.json"))).toBe(true);
  });

  it("persists branch files as schema-valid JSON", () => {
    const directory = makeDirectory();
    const store = makeStore(directory);
    store.fork("alpha", stateInput());
    const raw = JSON.parse(readFileSync(join(directory, "alpha.json"), "utf8"));
    expect(raw.name).toBe("alpha");
    expect(raw.checkpoint.schemaVersion).toBe(PLAN_BRANCH_SCHEMA_VERSION);
    expect(typeof raw.createdAt).toBe("string");
    expect(typeof raw.updatedAt).toBe("string");
  });
});
