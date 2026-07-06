import { describe, expect, it, vi } from "vitest";

import { makeSmokeDeps } from "../../src/selfbuild/smokeDeps.js";

describe("makeSmokeDeps (P7) — live SMOKE deps from capability-smoke", () => {
  it("runSmoke returns the capability-smoke verdict", async () => {
    const runCapabilitySmoke = vi.fn(async () => ({ verdict: "GREEN" as const }));
    const deps = makeSmokeDeps({ cwd: "/repo", runCapabilitySmoke });
    expect(await deps.runSmoke()).toEqual({ verdict: "GREEN" });
    expect(runCapabilitySmoke).toHaveBeenCalledWith({ cwd: "/repo" });
  });

  it("a RED nucleus surfaces as RED", async () => {
    const deps = makeSmokeDeps({ runCapabilitySmoke: async () => ({ verdict: "RED" }) });
    expect((await deps.runSmoke()).verdict).toBe("RED");
  });

  it("threads through an optional bounded self-call", async () => {
    const selfCall = async () => "ok";
    const deps = makeSmokeDeps({ runCapabilitySmoke: async () => ({ verdict: "GREEN" }), selfCall, timeoutMs: 500 });
    expect(deps.selfCall).toBe(selfCall);
    expect(deps.timeoutMs).toBe(500);
  });
});
