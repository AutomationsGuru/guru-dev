import { describe, expect, it } from "vitest";

import { runSmokeStage } from "../../src/selfbuild/smokeStage.js";

describe("runSmokeStage (P2) — nucleus boots + one bounded self-call", () => {
  it("smoke RED (nucleus broken) → RED, self-call skipped", async () => {
    const result = await runSmokeStage({
      runSmoke: async () => ({ verdict: "RED" }),
      selfCall: async () => "should not run"
    });
    expect(result.verdict).toBe("RED");
    expect(result.selfCall).toBe("skipped");
  });

  it("smoke GREEN + self-call returns → GREEN with a real result", async () => {
    let called = false;
    const result = await runSmokeStage({
      runSmoke: async () => ({ verdict: "GREEN" }),
      selfCall: async () => {
        called = true;
        return { ok: true };
      }
    });
    expect(called).toBe(true);
    expect(result.verdict).toBe("GREEN");
    expect(result.selfCall).toBe("ok");
  });

  it("smoke GREEN + a HANGING self-call → aborted by the timeout → RED (bounded, not a hang)", async () => {
    const result = await runSmokeStage({
      runSmoke: async () => ({ verdict: "GREEN" }),
      // never resolves on its own; the stage must still return via the timeout
      selfCall: (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("late"))),
      timeoutMs: 25
    });
    expect(result.verdict).toBe("RED");
    expect(result.selfCall).toBe("timeout");
  });

  it("smoke GREEN + a throwing self-call → RED (error), not a false GREEN", async () => {
    const result = await runSmokeStage({
      runSmoke: async () => ({ verdict: "GREEN" }),
      selfCall: async () => {
        throw new Error("boom in the new code");
      },
      timeoutMs: 1_000
    });
    expect(result.verdict).toBe("RED");
    expect(result.selfCall).toBe("error");
  });

  it("smoke YELLOW + no self-call wired → YELLOW (honest, carried through)", async () => {
    const result = await runSmokeStage({ runSmoke: async () => ({ verdict: "YELLOW" }) });
    expect(result.verdict).toBe("YELLOW");
    expect(result.selfCall).toBe("skipped");
  });
});
