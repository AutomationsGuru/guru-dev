import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initExtensions, collectExtensionTools } from "../../src/extensions/initExtensions.js";
import { createHarnessRuntime } from "../../src/runtime/session.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("initExtensions", () => {
  it("registers the folded capability tools on the extension host", () => {
    const { host, tools } = initExtensions();
    const ids = tools.map((tool) => tool.id);

    expect(host.getToolFactories().length).toBeGreaterThanOrEqual(2);
    expect(ids).toEqual(
      expect.arrayContaining([
        "honcho_memory_status",
        "honcho_remember",
        "honcho_recall",
        "honcho_context",
        "honcho_log_turn",
        "service_readiness_report"
      ])
    );
  });

  it("collectExtensionTools returns the contributed tool definitions", () => {
    const ids = collectExtensionTools().map((tool) => tool.id);

    expect(ids).toContain("honcho_memory_status");
    expect(ids).toContain("service_readiness_report");
  });
});

describe("extension tools wired into the live runtime", () => {
  it("exposes extension tools in a started harness session", async () => {
    const runtime = createHarnessRuntime();
    const session = await runtime.startSession({ cwd: repoRoot });
    const ids = session.tools.map((tool) => tool.id);

    expect(ids).toContain("honcho_memory_status");
    expect(ids).toContain("service_readiness_report");
  });

  it("executes honcho_memory_status through the live runtime", async () => {
    const runtime = createHarnessRuntime();
    const session = await runtime.startSession({ cwd: repoRoot });
    const observation = await runtime.executeTool(session.id, "honcho_memory_status", {});

    expect(observation.status).toBe("succeeded");
    expect((observation.output as { status?: string }).status).toMatch(/read-only|missing-env|ready/u);
  });
});
