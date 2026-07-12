import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCapabilitySmoke } from "../../src/readiness/capabilitySmoke.js";
import { createHarnessRuntime, type HarnessRuntime } from "../../src/runtime/session.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function trackClose(runtime: HarnessRuntime): { readonly runtime: HarnessRuntime; readonly closeCalls: () => number } {
  const closeRuntime = runtime.close.bind(runtime);
  let calls = 0;
  runtime.close = async () => {
    calls += 1;
    await closeRuntime();
  };
  return { runtime, closeCalls: () => calls };
}

describe("runCapabilitySmoke runtime lifecycle", () => {
  it("closes its internally constructed runtime after a successful smoke", async () => {
    const tracked = trackClose(createHarnessRuntime());

    const report = await runCapabilitySmoke({ cwd: repoRoot, runtimeFactory: () => tracked.runtime });

    expect(report.readOnlyToolRun.status).toBe("succeeded");
    expect(tracked.closeCalls()).toBe(1);
  });

  it("closes its internally constructed runtime when session startup fails", async () => {
    const tracked = trackClose(createHarnessRuntime());
    tracked.runtime.startSession = async () => {
      throw new Error("capability smoke startup failed");
    };

    await expect(runCapabilitySmoke({ cwd: repoRoot, runtimeFactory: () => tracked.runtime })).rejects.toThrow("capability smoke startup failed");
    expect(tracked.closeCalls()).toBe(1);
  });
});
