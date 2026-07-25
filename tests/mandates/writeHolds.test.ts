import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyWriteHolds,
  evaluateWriteHold,
  matchWriteHold,
  resolveWriteHoldTarget,
  evaluateToolMandate,
  type MandateContext
} from '../../src/mandates/evaluate.js';
import type { WriteHoldRule } from '../../src/config/projectLaw.js';
import type { MandateState } from '../../src/mandates/schema.js';

const EMPTY: MandateState = { grants: [], denies: [] };
const CWD = process.platform === "win32" ? "D:\\work\\repo" : "/work/repo";

const hold = (partial: Partial<WriteHoldRule> & Pick<WriteHoldRule, "text" | "paths" | "action">): WriteHoldRule => ({
  text: partial.text,
  paths: partial.paths,
  action: partial.action
});

function ctx(overrides: Partial<MandateContext> = {}): MandateContext {
  return { cwd: CWD, state: EMPTY, yolo: false, ...overrides };
}

/** Evaluate the mandate then apply holds — the exact composition approval paths run. */
function decideWithHolds(
  toolId: string,
  input: unknown,
  context: MandateContext,
  holds: readonly WriteHoldRule[]
) {
  const base = evaluateToolMandate(toolId, input, context);
  return applyWriteHolds(base, toolId, input, { cwd: context.cwd, root: context.cwd }, holds);
}

describe("resolveWriteHoldTarget", () => {
  it("resolves write/edit/fs.edit.apply path targets; ignores out-of-scope tools", () => {
    expect(resolveWriteHoldTarget("write", { path: "src/a.ts" }, CWD)).toBe(resolve(CWD, "src/a.ts"));
    expect(resolveWriteHoldTarget("edit", { path: "b.ts" }, CWD)).not.toBeNull();
    expect(resolveWriteHoldTarget("fs.edit.apply", { file: "c.ts" }, CWD)).not.toBeNull();
    expect(resolveWriteHoldTarget("bash", { command: "echo x>.env" }, CWD)).toBeNull(); // shell-mediated: v1 out of scope
    expect(resolveWriteHoldTarget("read", { path: "a.ts" }, CWD)).toBeNull();
    expect(resolveWriteHoldTarget("write", {}, CWD)).toBeNull(); // no path → cannot bind
  });
});

describe("matchWriteHold", () => {
  const root = CWD;
  it("matches ** across depths and * within a segment", () => {
    const rule = hold({ text: "core", paths: ["src/core/**"], action: "ask" });
    expect(matchWriteHold(rule, `${CWD}/src/core/deep/file.ts`, root)).toBe("src/core/**");
    expect(matchWriteHold(rule, `${CWD}/src/other/file.ts`, root)).toBeUndefined();

    const star = hold({ text: "flat", paths: ["src/*.ts"], action: "ask" });
    expect(matchWriteHold(star, `${CWD}/src/a.ts`, root)).toBe("src/*.ts");
    expect(matchWriteHold(star, `${CWD}/src/nested/a.ts`, root)).toBeUndefined(); // * does not cross /
  });

  it("matches a literal filename and a **/*.ext glob", () => {
    const env = hold({ text: "secrets", paths: [".env"], action: "block" });
    expect(matchWriteHold(env, `${CWD}/.env`, root)).toBe(".env");
    expect(matchWriteHold(env, `${CWD}/sub/.env`, root)).toBeUndefined();

    const pem = hold({ text: "keys", paths: ["**/*.pem"], action: "block" });
    expect(matchWriteHold(pem, `${CWD}/certs/prod.pem`, root)).toBe("**/*.pem");
    expect(matchWriteHold(pem, `${CWD}/prod.pem`, root)).toBe("**/*.pem");
  });

  it("does NOT substring-match a sibling sharing a prefix", () => {
    const rule = hold({ text: "x", paths: ["src/core/**"], action: "block" });
    // src/core2 must not be held by src/core/**
    expect(matchWriteHold(rule, `${CWD}/src/core2/file.ts`, root)).toBeUndefined();
  });

  it("matches absolute patterns against the absolute target", () => {
    const abs = hold({ text: "abs", paths: [`${CWD}/secrets/**`], action: "block" });
    expect(matchWriteHold(abs, `${CWD}/secrets/key.txt`, root)).toBe(`${CWD}/secrets/**`);
  });
});

describe("evaluateWriteHold", () => {
  it("block beats ask when both match, and emits an audit per fired hold", () => {
    const holds = [
      hold({ text: "ask first", paths: ["src/**"], action: "ask" }),
      hold({ text: "block core", paths: ["src/core/**"], action: "block" })
    ];
    const verdict = evaluateWriteHold("write", { path: "src/core/x.ts" }, CWD, holds, CWD);
    expect(verdict?.hold?.action).toBe("block");
    expect(verdict?.hold?.text).toBe("block core");
    expect(verdict?.audits).toHaveLength(2); // both rules fired, audited
    expect(verdict?.audits.every((a) => a.path.endsWith("src/core/x.ts"))).toBe(true);
  });

  it("audit carries invariant text + path, never file contents", () => {
    const holds = [hold({ text: "INVARIANT-MSG", paths: ["src/**"], action: "ask" })];
    const verdict = evaluateWriteHold("write", { path: "src/a.ts", contents: "SECRET_BODY" }, CWD, holds, CWD);
    expect(verdict?.audits[0]?.text).toBe("INVARIANT-MSG");
    expect(JSON.stringify(verdict?.audits)).not.toContain("SECRET_BODY");
  });

  it("returns null when no hold matches or tool is out of scope", () => {
    const holds = [hold({ text: "core", paths: ["src/core/**"], action: "block" })];
    expect(evaluateWriteHold("write", { path: "README.md" }, CWD, holds, CWD)).toBeNull();
    expect(evaluateWriteHold("bash", { command: "ls" }, CWD, holds, CWD)).toBeNull();
    expect(evaluateWriteHold("write", { path: "src/core/x.ts" }, CWD, [], CWD)).toBeNull();
  });
});

describe("applyWriteHolds — tighten-only, binds under YOLO", () => {
  it("YOLO cannot write a BLOCKED path (deny) — plan requirement", () => {
    // A non-hard-edge path: under YOLO the base mandate ALLOWS this silently,
    // and the block hold must turn that silent allow into a hard DENY.
    const holds = [hold({ text: "Do not touch migrations", paths: ["db/migrations/**"], action: "block" })];
    const base = evaluateToolMandate("write", { path: "db/migrations/001.sql" }, ctx({ yolo: true }));
    expect(base.outcome).toBe("allow"); // YOLO would pass it without the hold
    const decision = decideWithHolds("write", { path: "db/migrations/001.sql", contents: "x" }, ctx({ yolo: true }), holds);
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("write hold (block)");
    expect(decision.reason).toContain("Do not touch migrations");
  });

  it("a BLOCK hold TIGHTENS a hard-edge escalate into a deny (deny is stronger), keeping hard-edge verbs", () => {
    // .env write is a secret-edge hard edge (escalate → operator may approve).
    // A block hold is STRICTLY stronger: it removes the approval path entirely.
    const holds = [hold({ text: "Never touch .env", paths: [".env"], action: "block" })];
    const decision = decideWithHolds("write", { path: ".env", contents: "x" }, ctx({ yolo: true }), holds);
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("write hold (block)");
    expect(decision.verbs).toContain("secret-edge"); // verbs preserved for surfacing
  });

  it("an ASK hold never downgrades a hard edge (keeps its always-prompt verbs)", () => {
    // .env write is a secret-edge hard edge. An ask hold must NOT replace it
    // with a non-hard-edge escalate, or the approval path would offer a session
    // "always" and stop re-prompting on a secrets-adjacent write.
    const holds = [hold({ text: "ask about env", paths: [".env"], action: "ask" })];
    const base = evaluateToolMandate("write", { path: ".env" }, ctx({ yolo: true }));
    expect(base.outcome).toBe("escalate");
    expect(base.verbs).toContain("secret-edge");
    const decision = decideWithHolds("write", { path: ".env" }, ctx({ yolo: true }), holds);
    expect(decision).toEqual(base); // untouched — hard edge intact
  });

  it("ASK hold forces an escalate (prompt) even under YOLO — plan requirement", () => {
    const holds = [hold({ text: "Confirm core edits", paths: ["src/core/**"], action: "ask" })];
    // Under YOLO the base mandate ALLOWS this silently; the hold must interrupt it.
    const base = evaluateToolMandate("write", { path: "src/core/x.ts" }, ctx({ yolo: true }));
    expect(base.outcome).toBe("allow");
    const decision = decideWithHolds("write", { path: "src/core/x.ts" }, ctx({ yolo: true }), holds);
    expect(decision.outcome).toBe("escalate");
    expect(decision.reason).toContain("write hold (ask)");
    expect(decision.reason).toContain("Confirm core edits");
  });

  it("ASK hold forces an escalate even with a covering machine grant", () => {
    const state: MandateState = { grants: [{ scope: "machine", verbs: ["write"], grantedAt: "2026-07-18T00:00:00Z" }], denies: [] };
    const holds = [hold({ text: "Confirm", paths: ["src/**"], action: "ask" })];
    const base = evaluateToolMandate("write", { path: "src/a.ts" }, ctx({ state, yolo: false }));
    expect(base.outcome).toBe("allow"); // grant covers it
    const decision = decideWithHolds("write", { path: "src/a.ts" }, ctx({ state, yolo: false }), holds);
    expect(decision.outcome).toBe("escalate"); // hold still interrupts
  });

  it("never weakens an existing deny (deny-wins preserved)", () => {
    const state: MandateState = { grants: [], denies: [{ verb: "write", path: CWD }] };
    const holds = [hold({ text: "ask", paths: ["src/**"], action: "ask" })];
    const decision = decideWithHolds("write", { path: "src/a.ts" }, ctx({ state }), holds);
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).not.toContain("write hold"); // untouched
  });

  it("a hold can only add friction — allow→escalate→deny, never the reverse", () => {
    const holds = [hold({ text: "hold", paths: ["src/**"], action: "ask" })];
    const rank = { allow: 0, escalate: 1, deny: 2 } as const;
    for (const yolo of [false, true]) {
      const base = evaluateToolMandate("write", { path: "src/a.ts" }, ctx({ yolo }));
      const held = decideWithHolds("write", { path: "src/a.ts" }, ctx({ yolo }), holds);
      expect(rank[held.outcome]).toBeGreaterThanOrEqual(rank[base.outcome]);
    }
  });

  it("non-matching paths are unaffected under YOLO", () => {
    const holds = [hold({ text: "core", paths: ["src/core/**"], action: "block" })];
    const decision = decideWithHolds("write", { path: "src/other/a.ts" }, ctx({ yolo: true }), holds);
    expect(decision.outcome).toBe("allow"); // YOLO still lifts routine work outside the hold
  });

  it("no holds (fail-open) leaves the mandate decision exactly as before", () => {
    const base = evaluateToolMandate("write", { path: "src/a.ts" }, ctx({ yolo: true }));
    const held = decideWithHolds("write", { path: "src/a.ts" }, ctx({ yolo: true }), []);
    expect(held).toEqual(base);
  });
});
