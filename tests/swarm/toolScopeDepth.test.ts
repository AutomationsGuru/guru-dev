import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_SPAWN_DEPTH,
  ABSOLUTE_MAX_SPAWN_DEPTH,
  assertSpawnDepthWithinLimit,
  checkSpawnDepthWithinLimit,
  childSpawnDepth,
  nextSpawnDepth
} from '../../src/swarm/spawnDepth.js';
import {
  HARD_LIMIT_BYPASS_TOOL_IDS,
  SPAWN_AGENT_TOOL_ID,
  deriveWorkerToolAllowlist,
  narrowWorkerToolAllowlist
} from '../../src/swarm/toolScope.js';

describe("swarm tool scoping (IDEA-F6 R-GO-SUB-SCOPE)", () => {
  describe("default = parent minus spawn tool", () => {
    it("strips spawn_agent from the default allowlist", () => {
      const parent = ["read", "write", "bash", SPAWN_AGENT_TOOL_ID];
      const result = deriveWorkerToolAllowlist({ parentToolIds: parent });
      expect(result.allowlist).toEqual(["bash", "read", "write"]);
      expect(result.allowlist).not.toContain(SPAWN_AGENT_TOOL_ID);
      expect(result.dropped).toEqual([{ id: SPAWN_AGENT_TOOL_ID, reason: "spawn_tool" }]);
    });

    it("returns an empty allowlist when the parent only had spawn_agent", () => {
      const result = deriveWorkerToolAllowlist({ parentToolIds: [SPAWN_AGENT_TOOL_ID] });
      expect(result.allowlist).toEqual([]);
      expect(result.dropped).toEqual([{ id: SPAWN_AGENT_TOOL_ID, reason: "spawn_tool" }]);
    });

    it("an explicit request can re-include spawn_agent (opt-in recursion), provided the parent had it", () => {
      const parent = ["read", SPAWN_AGENT_TOOL_ID];
      const result = deriveWorkerToolAllowlist({
        parentToolIds: parent,
        requestedAllowlist: ["read", SPAWN_AGENT_TOOL_ID]
      });
      expect(result.allowlist).toEqual(["read", SPAWN_AGENT_TOOL_ID]);
      expect(result.dropped).toEqual([]);
    });

    it("an explicit request cannot re-include spawn_agent when the parent did not have it", () => {
      const result = deriveWorkerToolAllowlist({
        parentToolIds: ["read"],
        requestedAllowlist: ["read", SPAWN_AGENT_TOOL_ID]
      });
      expect(result.allowlist).toEqual(["read"]);
      expect(result.dropped).toEqual([{ id: SPAWN_AGENT_TOOL_ID, reason: "not_in_parent" }]);
    });
  });

  describe("subset enforcement — worker can never widen past the parent", () => {
    it("intersection: requested allowlist drops ids the parent does not have", () => {
      const result = deriveWorkerToolAllowlist({
        parentToolIds: ["read", "write"],
        requestedAllowlist: ["read", "bash", "edit"]
      });
      expect(result.allowlist).toEqual(["read"]);
      expect(result.dropped).toContainEqual({ id: "bash", reason: "not_in_parent" });
      expect(result.dropped).toContainEqual({ id: "edit", reason: "not_in_parent" });
    });

    it("requested allowlist narrows further than the default", () => {
      const result = deriveWorkerToolAllowlist({
        parentToolIds: ["read", "write", "bash", "edit"],
        requestedAllowlist: ["read"]
      });
      expect(result.allowlist).toEqual(["read"]);
    });

    it("output is deterministic: sorted + deduplicated", () => {
      const result = deriveWorkerToolAllowlist({
        parentToolIds: ["write", "read", "read", "bash", "write"]
      });
      expect(result.allowlist).toEqual(["bash", "read", "write"]);
    });
  });

  describe("hard-limit bypass tools stay excluded, unconditionally", () => {
    it("strips every hard-limit bypass id from the default allowlist", () => {
      const parent = ["read", "write", ...HARD_LIMIT_BYPASS_TOOL_IDS];
      const result = deriveWorkerToolAllowlist({ parentToolIds: parent });
      expect(result.allowlist).toEqual(["read", "write"]);
      for (const id of HARD_LIMIT_BYPASS_TOOL_IDS) {
        expect(result.allowlist).not.toContain(id);
      }
      // Each bypass id is reported with its reason.
      const droppedIds = new Set(result.dropped.filter((d) => d.reason === "hard_limit_bypass").map((d) => d.id));
      for (const id of HARD_LIMIT_BYPASS_TOOL_IDS) {
        expect(droppedIds.has(id)).toBe(true);
      }
    });

    it("an explicit request CANNOT re-include a hard-limit bypass id, even when the parent has it", () => {
      const result = deriveWorkerToolAllowlist({
        parentToolIds: ["read", "git.pr.run", "provider_cli_run", "schedule"],
        requestedAllowlist: ["read", "git.pr.run", "provider_cli_run", "schedule"]
      });
      expect(result.allowlist).toEqual(["read"]);
      expect(result.dropped).toContainEqual({ id: "git.pr.run", reason: "hard_limit_bypass" });
      expect(result.dropped).toContainEqual({ id: "provider_cli_run", reason: "hard_limit_bypass" });
      expect(result.dropped).toContainEqual({ id: "schedule", reason: "hard_limit_bypass" });
    });

    it("a YOLO parent with the full surface still yields a worker without the bypass set", () => {
      // Simulates a parent in full YOLO: ship tools, scheduler, provider CLI, desktop automation.
      const yoloParent = [
        "read",
        "write",
        "edit",
        "bash",
        "shell.command.run",
        "git.pr.run",
        "github.pr.comment",
        "github.pr.review",
        "github.pr.status",
        "manage_task",
        "schedule",
        "provider_cli_run",
        "pyautogui_status",
        "pyautogui_screen",
        "pyautogui_mouse",
        "pyautogui_keyboard",
        "review.gates.run",
        "maintenance.audit.run",
        "operational.implementation.create",
        "operational.decision.upsert",
        "operational.blocker.record",
        "operational.backlog.create",
        SPAWN_AGENT_TOOL_ID
      ];
      const result = deriveWorkerToolAllowlist({ parentToolIds: yoloParent });
      // Only the ordinary workspace tools reach the worker.
      expect(result.allowlist).toEqual(["bash", "edit", "read", "shell.command.run", "write"]);
      for (const id of HARD_LIMIT_BYPASS_TOOL_IDS) {
        expect(result.allowlist).not.toContain(id);
      }
      expect(result.allowlist).not.toContain(SPAWN_AGENT_TOOL_ID);
    });

    it("the bypass set is frozen and contains the expected ids", () => {
      // Pin the constitution in code: these ids must never become worker-reachable
      // without an explicit, reviewed change to this set.
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("git.pr.run")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("provider_cli_run")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("schedule")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("manage_task")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("pyautogui_status")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("pyautogui_screen")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("pyautogui_mouse")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("pyautogui_keyboard")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("review.gates.run")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("maintenance.audit.run")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("github.pr.comment")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("github.pr.review")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("github.pr.status")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("operational.implementation.create")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("operational.decision.upsert")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("operational.blocker.record")).toBe(true);
      expect(HARD_LIMIT_BYPASS_TOOL_IDS.has("operational.backlog.create")).toBe(true);
    });
  });

  describe("nested narrowing — a worker spawning its own sub-worker", () => {
    it("the same containment applies at every level of the tree", () => {
      // Parent (YOLO, has spawn tool): spawns worker-1 with default containment.
      const level1 = deriveWorkerToolAllowlist({
        parentToolIds: ["read", "write", "git.pr.run", SPAWN_AGENT_TOOL_ID],
        requestedAllowlist: ["read", "write", SPAWN_AGENT_TOOL_ID] // worker-1 opts into recursion
      });
      expect(level1.allowlist).toEqual(["read", SPAWN_AGENT_TOOL_ID, "write"]);
      expect(level1.allowlist).not.toContain("git.pr.run");

      // Worker-1 spawns worker-2: spawn_agent is again stripped by default.
      const level2 = narrowWorkerToolAllowlist(level1.allowlist);
      expect(level2.allowlist).toEqual(["read", "write"]);
      expect(level2.allowlist).not.toContain(SPAWN_AGENT_TOOL_ID);
      expect(level2.allowlist).not.toContain("git.pr.run");
    });

    it("a worker cannot smuggle a bypass id into its own child by re-adding it", () => {
      const level1 = deriveWorkerToolAllowlist({
        parentToolIds: ["read", "git.pr.run"],
        requestedAllowlist: ["read"]
      });
      // level1 has neither git.pr.run nor spawn_agent — the worker physically
      // cannot pass either down. The drop reason is `not_in_parent` (the
      // caller is told it lacks the tool) — the bypass strip is upstream.
      const level2 = narrowWorkerToolAllowlist(level1.allowlist, ["read", "git.pr.run"]);
      expect(level2.allowlist).toEqual(["read"]);
      expect(level2.dropped).toContainEqual({ id: "git.pr.run", reason: "not_in_parent" });
    });

    it("when a worker DOES have a tool the bypass set later targets, the bypass strip wins", () => {
      // Constructed case: the bypass set is the authoritative strip. If a
      // worker somehow ended up with an id that the bypass set targets (e.g.,
      // the set is tightened later), the strip still applies on the way down.
      const workerSurface = ["read", "git.pr.run"];
      const result = narrowWorkerToolAllowlist(workerSurface);
      expect(result.allowlist).toEqual(["read"]);
      expect(result.dropped).toContainEqual({ id: "git.pr.run", reason: "hard_limit_bypass" });
    });
  });
});

describe("swarm spawn-depth (IDEA-F6 R-GO-SUB-SCOPE)", () => {
  describe("canonical constants", () => {
    it("DEFAULT_MAX_SPAWN_DEPTH is 2 per the F6 plan", () => {
      expect(DEFAULT_MAX_SPAWN_DEPTH).toBe(2);
    });

    it("ABSOLUTE_MAX_SPAWN_DEPTH matches the schema hard cap (8)", () => {
      expect(ABSOLUTE_MAX_SPAWN_DEPTH).toBe(8);
    });
  });

  describe("nextSpawnDepth", () => {
    it("increments a valid depth", () => {
      expect(nextSpawnDepth(0)).toBe(1);
      expect(nextSpawnDepth(1)).toBe(2);
      expect(nextSpawnDepth(2)).toBe(3);
    });

    it("rejects non-integer or negative input", () => {
      expect(() => nextSpawnDepth(-1)).toThrow(RangeError);
      expect(() => nextSpawnDepth(1.5)).toThrow(RangeError);
      expect(() => nextSpawnDepth(Number.NaN)).toThrow(RangeError);
    });
  });

  describe("checkSpawnDepthWithinLimit (non-throwing)", () => {
    it("allows depths at or under the limit", () => {
      expect(checkSpawnDepthWithinLimit(0, 2)).toEqual({ allowed: true, depth: 0, limit: 2 });
      expect(checkSpawnDepthWithinLimit(2, 2)).toEqual({ allowed: true, depth: 2, limit: 2 });
    });

    it("denies depth beyond the limit with a reason", () => {
      const result = checkSpawnDepthWithinLimit(3, 2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeds the limit");
    });

    it("refuses a limit above the absolute cap (defense against a bad config)", () => {
      const result = checkSpawnDepthWithinLimit(1, ABSOLUTE_MAX_SPAWN_DEPTH + 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("absolute cap");
    });

    it("refuses non-positive limits and non-integer depths", () => {
      expect(checkSpawnDepthWithinLimit(1, 0).allowed).toBe(false);
      expect(checkSpawnDepthWithinLimit(-1, 2).allowed).toBe(false);
      expect(checkSpawnDepthWithinLimit(1.5, 2).allowed).toBe(false);
    });
  });

  describe("assertSpawnDepthWithinLimit (throwing)", () => {
    it("does not throw when depth is at or under the limit", () => {
      expect(() => assertSpawnDepthWithinLimit(0, DEFAULT_MAX_SPAWN_DEPTH)).not.toThrow();
      expect(() => assertSpawnDepthWithinLimit(2, DEFAULT_MAX_SPAWN_DEPTH)).not.toThrow();
    });

    it("throws RangeError when depth exceeds the limit", () => {
      expect(() => assertSpawnDepthWithinLimit(3, DEFAULT_MAX_SPAWN_DEPTH)).toThrow(RangeError);
      expect(() => assertSpawnDepthWithinLimit(3, DEFAULT_MAX_SPAWN_DEPTH)).toThrow(/exceeds the limit/);
    });
  });

  describe("childSpawnDepth — the call-site for the spawn tool", () => {
    it("returns the incremented depth when within the limit", () => {
      expect(childSpawnDepth(0, DEFAULT_MAX_SPAWN_DEPTH)).toBe(1);
      expect(childSpawnDepth(1, DEFAULT_MAX_SPAWN_DEPTH)).toBe(2);
    });

    it("refuses the spawn that would cross the hard max", () => {
      // At the default of 2: a depth-2 worker trying to spawn is refused.
      expect(() => childSpawnDepth(2, DEFAULT_MAX_SPAWN_DEPTH)).toThrow(RangeError);
      expect(() => childSpawnDepth(2, DEFAULT_MAX_SPAWN_DEPTH)).toThrow(/exceeds the limit of 2/);
    });

    it("a custom limit is honored (and the absolute cap still binds)", () => {
      expect(childSpawnDepth(0, 1)).toBe(1);
      expect(() => childSpawnDepth(1, 1)).toThrow(/exceeds the limit of 1/);
      expect(() => childSpawnDepth(0, ABSOLUTE_MAX_SPAWN_DEPTH + 5)).toThrow(/absolute cap/);
    });
  });

  describe("default = 2 end-to-end shape (the plan's contract)", () => {
    it("parent (depth 0) → worker (depth 1) → grandchild (depth 2) → REFUSED", () => {
      // Depth 0 parent: can spawn.
      const workerDepth = childSpawnDepth(0, DEFAULT_MAX_SPAWN_DEPTH);
      expect(workerDepth).toBe(1);
      // Depth 1 worker: can spawn.
      const grandchildDepth = childSpawnDepth(workerDepth, DEFAULT_MAX_SPAWN_DEPTH);
      expect(grandchildDepth).toBe(2);
      // Depth 2 grandchild: cannot spawn.
      expect(() => childSpawnDepth(grandchildDepth, DEFAULT_MAX_SPAWN_DEPTH)).toThrow(/exceeds the limit of 2/);
    });
  });
});
