import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initExtensions, collectExtensionTools } from "../../src/extensions/initExtensions.js";
import { createHarnessRuntime } from "../../src/runtime/session.js";
import { MemoryConfigSchema } from "../../src/config/schema.js";

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
        "memory_status",
        "service_readiness_report",
        "todo_write",
        "todo_list",
        "web_fetch",
        "web_search",
        "mcp_bridge_status",
        "provider_cli_status",
        "provider_cli_run",
        "pyautogui_status",
        "pyautogui_screen",
        "pyautogui_mouse",
        "pyautogui_keyboard"
      ])
    );
  });

  it("collectExtensionTools returns the contributed tool definitions", () => {
    const ids = collectExtensionTools().map((tool) => tool.id);

    expect(ids).toContain("honcho_memory_status");
    expect(ids).toContain("memory_status");
    expect(ids).toContain("service_readiness_report");
    expect(ids).toContain("todo_write");
    expect(ids).toContain("web_fetch");
    expect(ids).toContain("web_search");
    // ask_question ships in the BASE tool set (not extensions) so the TUI/RPC
    // onAsk injection seam reaches it — see baseToolFactory.ts.
    expect(ids).not.toContain("ask_question");
    expect(ids).toContain("mcp_bridge_status");
    expect(ids).toContain("provider_cli_status");
    expect(ids).toContain("pyautogui_status");
  });

  it("rebuilds the shared extension memory backend for an explicitly configured PostgreSQL session", async () => {
    const memoryConfig = MemoryConfigSchema.parse({
      storage: {
        provider: "postgres",
        postgres: { connectionStringEnvVar: "GURU_TEST_UNSET_MEMORY_DATABASE_URL", schema: "guru_memory", table: "facts", ssl: "disable" }
      }
    });
    const { tools } = initExtensions({ memoryConfig });
    const statusTool = tools.find((tool) => tool.id === "memory_status");

    expect(statusTool).toBeDefined();
    expect(await statusTool!.execute({}, {})).toMatchObject({ provider: "postgres", status: "missing-env", missingEnvNames: ["GURU_TEST_UNSET_MEMORY_DATABASE_URL"] });
  });

  it("reuses the shared extension host when the memory configuration and directory are unchanged", () => {
    const memoryDirectory = resolve(repoRoot, ".test-memory", "same-config");

    const first = initExtensions({ memoryDirectory });
    const second = initExtensions({ memoryDirectory });

    expect(second.host).toBe(first.host);
    expect(second.memoryStore).toBe(first.memoryStore);
  });

  it("rebuilds the shared extension host when the memory directory changes", () => {
    const first = initExtensions({ memoryDirectory: resolve(repoRoot, ".test-memory", "directory-a") });
    const second = initExtensions({ memoryDirectory: resolve(repoRoot, ".test-memory", "directory-b") });

    expect(second.host).not.toBe(first.host);
    expect(second.memoryStore).not.toBe(first.memoryStore);
  });

  it("rebuilds the shared extension host when the session provenance changes", async () => {
    const memoryDirectory = mkdtempSync(resolve(tmpdir(), "guru-init-extensions-session-"));

    try {
      const memoryConfig = MemoryConfigSchema.parse({});
      const first = initExtensions({ memoryConfig, memoryDirectory, sessionId: "one" });
      const second = initExtensions({ memoryConfig, memoryDirectory, sessionId: "two" });
      const remembered = await second.memoryStore.remember({
        name: "session-provenance",
        title: "Session provenance",
        description: "The rebuilt store uses the latest session.",
        body: "Latest session provenance.",
        type: "project",
        edit: "replace",
        confidence: 1
      });
      const stored = await second.memoryStore.get("session-provenance");

      expect(remembered.status).toBe("created");
      expect(stored.fact?.originSessionId).toBe("two");
      expect(second.host).not.toBe(first.host);
      expect(second.memoryStore).not.toBe(first.memoryStore);
    } finally {
      rmSync(memoryDirectory, { recursive: true, force: true });
    }
  });

  it("lets a bare runtime lookup reuse an explicitly configured extension host", () => {
    const configured = initExtensions({
      memoryConfig: MemoryConfigSchema.parse({}),
      memoryDirectory: resolve(repoRoot, ".test-memory", "configured-runtime")
    });

    const retrieved = initExtensions();

    expect(retrieved.host).toBe(configured.host);
    expect(retrieved.memoryStore).toBe(configured.memoryStore);
  });
});

describe("extension tools wired into the live runtime", () => {
  it("exposes extension tools in a started harness session", async () => {
    const runtime = createHarnessRuntime();
    const session = await runtime.startSession({ cwd: repoRoot });
    const ids = session.tools.map((tool) => tool.id);

    expect(ids).toContain("honcho_memory_status");
    expect(ids).toContain("memory_status");
    expect(ids).toContain("service_readiness_report");
    expect(ids).toContain("todo_list");
    expect(ids).toContain("web_fetch");
    expect(ids).toContain("web_search");
    expect(ids).toContain("ask_question");
    expect(ids).toContain("mcp_bridge_status");
    expect(ids).toContain("provider_cli_status");
    expect(ids).toContain("pyautogui_status");
    expect(ids).toContain("pyautogui_mouse");
  });

  it("executes honcho_memory_status through the live runtime", async () => {
    const runtime = createHarnessRuntime();
    const session = await runtime.startSession({ cwd: repoRoot });
    const observation = await runtime.executeTool(session.id, "honcho_memory_status", {});

    expect(observation.status).toBe("succeeded");
    expect((observation.output as { status?: string }).status).toMatch(/disabled|missing-env|offline|ready/u);
  });
});
