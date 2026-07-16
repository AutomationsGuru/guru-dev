import { join } from "path";

import { createExtensionHost } from "../../src/extensions/host.js";
import { LifecycleEvents } from "../../src/extensions/events.js";
import { registerShellHooks } from "../../src/extensions/shellHooks.js";

const hookMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  execFile: vi.fn()
}));

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: hookMocks.existsSync
}));

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: hookMocks.execFile
}));

function startShellHookHost(): ReturnType<typeof createExtensionHost> {
  const host = createExtensionHost();
  host.registerExtension(registerShellHooks);
  host.start();
  hookMocks.execFile.mockClear();
  return host;
}

describe("shell hook tool-result lifecycle", () => {
  beforeEach(() => {
    hookMocks.existsSync.mockReset();
    hookMocks.execFile.mockReset();
  });

  it("runs tool-result.sh with only the sanitized result metadata", () => {
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-result.sh"));
    const host = startShellHookHost();
    const observation = {
      toolId: "read",
      status: "succeeded",
      startedAt: "2026-07-15T00:00:00.000Z",
      endedAt: "2026-07-15T00:00:00.001Z",
      durationMs: 1,
      output: { text: "sanitized" }
    };

    host.sendMessage(LifecycleEvents.TOOL_RESULT, { toolId: "read", output: observation });

    expect(hookMocks.execFile).toHaveBeenCalledTimes(1);
    expect(hookMocks.execFile.mock.calls[0]?.[0]).toBe("bash");
    expect(hookMocks.execFile.mock.calls[0]?.[1]).toEqual([join(process.cwd(), ".guru", "hooks", "tool-result.sh")]);
    expect(hookMocks.execFile.mock.calls[0]?.[2]).toMatchObject({
      env: expect.objectContaining({
        GURU_TOOL_ID: "read",
        GURU_TOOL_STATUS: "succeeded",
        GURU_TOOL_OUTPUT: JSON.stringify(observation)
      })
    });
    expect(hookMocks.execFile.mock.calls[0]?.[2]?.env).not.toHaveProperty("GURU_TOOL_INPUT");
  });

  it("runs tool-result.ps1 through pwsh argv with failed status metadata", () => {
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-result.ps1"));
    const host = startShellHookHost();
    const observation = {
      toolId: "missing",
      status: "failed",
      startedAt: "2026-07-15T00:00:00.000Z",
      endedAt: "2026-07-15T00:00:00.001Z",
      durationMs: 1,
      error: "sanitized failure"
    };

    host.sendMessage(LifecycleEvents.TOOL_RESULT, { toolId: "missing", output: observation });

    expect(hookMocks.execFile).toHaveBeenCalledTimes(1);
    expect(hookMocks.execFile.mock.calls[0]?.[0]).toBe("pwsh");
    expect(hookMocks.execFile.mock.calls[0]?.[1]).toEqual([
      "-NoProfile",
      "-File",
      join(process.cwd(), ".guru", "hooks", "tool-result.ps1")
    ]);
    expect(hookMocks.execFile.mock.calls[0]?.[2]).toMatchObject({
      env: expect.objectContaining({
        GURU_TOOL_ID: "missing",
        GURU_TOOL_STATUS: "failed",
        GURU_TOOL_OUTPUT: JSON.stringify(observation)
      })
    });
  });

  it("bounds cyclic external payloads and keeps hook-process errors inside the listener", () => {
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-result.sh"));
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("spawn failed"));
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = startShellHookHost();
    const cyclic: Record<string, unknown> = { status: "unexpected", raw: "DO_NOT_LEAK" };
    cyclic.self = cyclic;

    try {
      expect(() => host.sendMessage(LifecycleEvents.TOOL_RESULT, { toolId: "external", output: cyclic })).not.toThrow();
      expect(hookMocks.execFile).toHaveBeenCalledTimes(1);
      const env = hookMocks.execFile.mock.calls[0]?.[2]?.env;
      expect(env).toEqual(
        expect.objectContaining({
          GURU_TOOL_ID: "external",
          GURU_TOOL_STATUS: "unknown"
        })
      );
      expect(env?.GURU_TOOL_OUTPUT).not.toContain("DO_NOT_LEAK");
      expect(String(env?.GURU_TOOL_OUTPUT).length).toBeLessThanOrEqual(128);
      expect(consoleError).toHaveBeenCalledWith("[shell-hooks] Error executing tool-result:", "spawn failed");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not throw when an external result shape traps property access", () => {
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-result.sh"));
    const host = startShellHookHost();
    const malformed = new Proxy(
      {},
      {
        has() {
          throw new Error("property trap");
        },
        get() {
          throw new Error("property trap");
        }
      }
    );

    expect(() => host.sendMessage(LifecycleEvents.TOOL_RESULT, { toolId: "external", output: malformed })).not.toThrow();
    expect(hookMocks.execFile.mock.calls[0]?.[2]?.env).toEqual(
      expect.objectContaining({
        GURU_TOOL_STATUS: "unknown",
        GURU_TOOL_OUTPUT: expect.not.stringContaining("property trap")
      })
    );
  });
});
