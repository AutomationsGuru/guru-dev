import { createHash } from "node:crypto";

import {
  findToolParityRow,
  getToolParityRows,
  getToolParityVerdictCounts,
  TOOL_PARITY_MANIFEST,
  ToolParityManifestSchema,
  ToolParityRowSchema,
  validateToolParityManifest
} from "../../src/tools/toolParity.js";

describe("tool parity map", () => {
  it("should parse the parity manifest with strict schemas", () => {
    expect(() => validateToolParityManifest()).not.toThrow();
    expect(ToolParityManifestSchema.parse(TOOL_PARITY_MANIFEST).generatedBy).toBe("dev3-wave0-tool-parity-map");
  });

  it("should include every required extension-tool family", () => {
    const ids = getToolParityRows().map((row) => row.toolId);

    expect(ids).toEqual(
      expect.arrayContaining([
        "read",
        "bash",
        "edit",
        "write",
        "todo_write",
        "honcho_memory_status",
        "honcho_remember",
        "honcho_recall",
        "honcho_context",
        "honcho_log_turn",
        "mcp_bridge_status",
        "mcp_list_tools",
        "mcp_call_tool",
        "web_fetch",
        "web_search",
        "perplexity_research",
        "provider_cli_status",
        "provider_cli_run",
        "pyautogui_status",
        "pyautogui_screen",
        "pyautogui_mouse",
        "pyautogui_keyboard",
        "repo_route_lookup",
        "ask_question",
        "service_health"
      ])
    );
  });

  it("should mark folded base tools as native-equivalent GREEN", () => {
    for (const id of ["read", "bash", "edit", "write"]) {
      expect(findToolParityRow(id)).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    }
    expect(findToolParityRow("bash")?.currentGuruHarnessToolIds).toContain("bash");
    expect(findToolParityRow("edit")?.currentGuruHarnessToolIds).toContain("edit");
  });

  it("should keep repo_route_lookup as a partial equivalent", () => {
    expect(findToolParityRow("repo_route_lookup")).toMatchObject({
      status: "partial-equivalent",
      currentGuruHarnessToolIds: ["repo.context.resolve"]
    });
  });

  it("should report schedule as partial because only in-process one-shot delivery is supported", () => {
    expect(findToolParityRow("schedule")).toMatchObject({
      status: "partial-equivalent",
      verdict: "YELLOW",
      currentGuruHarnessToolIds: ["schedule"]
    });
    expect(findToolParityRow("schedule")?.notes).toMatch(/one-shot/iu);
    expect(findToolParityRow("schedule")?.nextAction).toMatch(/durable|cron|recurring/iu);
  });

  it("should keep service_health as partial equivalent (G636)", () => {
    expect(findToolParityRow("service_health")).toMatchObject({
      status: "partial-equivalent",
      verdict: "YELLOW",
      currentGuruHarnessToolIds: ["service_readiness_report"]
    });
  });

  it("should mark desktop pyautogui tools GREEN", () => {
    for (const id of ["pyautogui_status", "pyautogui_screen", "pyautogui_mouse", "pyautogui_keyboard"]) {
      expect(findToolParityRow(id)).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
      expect(findToolParityRow(id)?.currentGuruHarnessToolIds).toContain(id);
    }
  });

  it("should mark MCP list/call/status, todo board, provider CLI, and research tools GREEN", () => {
    expect(findToolParityRow("mcp_list_tools")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    expect(findToolParityRow("mcp_call_tool")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    expect(findToolParityRow("mcp_bridge_status")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    expect(findToolParityRow("todo_write")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    expect(findToolParityRow("provider_cli_status")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    expect(findToolParityRow("provider_cli_run")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    expect(findToolParityRow("web_search")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    expect(findToolParityRow("web_fetch")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
    expect(findToolParityRow("ask_question")).toMatchObject({ status: "native-equivalent", verdict: "GREEN" });
  });

  it("should report the complete manage_task background-parity truth", () => {
    expect(findToolParityRow("manage_task")).toEqual({
      toolId: "manage_task",
      category: "base-tool",
      requirementIds: ["FR-08", "TR-19"],
      currentGuruHarnessToolIds: ["manage_task"],
      status: "partial-equivalent",
      verdict: "YELLOW",
      ownerModule: "src/tools/builtins/manageTaskTool.ts",
      notes: "Task-registry management exists through manage_task, but bash has no background-task ingress and GuruHarness has no monitor/stream surface.",
      nextAction: "Add bounded background ingress and monitoring before claiming native parity."
    });
  });

  it("should preserve every non-manage_task parity row", () => {
    const rows = getToolParityRows().filter((row) => row.toolId !== "manage_task");
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");

    expect(rows).toHaveLength(26);
    expect(digest).toBe("da877d5db16dee3dd32a4e938c9c043af3b314ea035ab7f6bb3756b7eeb464e3");
  });

  it("should keep rows unique and schema-valid", () => {
    const rows = getToolParityRows();
    const ids = rows.map((row) => row.toolId);

    expect(new Set(ids).size).toBe(ids.length);
    for (const row of rows) {
      expect(() => ToolParityRowSchema.parse(row)).not.toThrow();
    }
  });

  it("should summarize RED/YELLOW/GREEN counts", () => {
    // No RED rows remain; perplexity + repo + schedule + service health + manage_task stay YELLOW partials.
    expect(getToolParityVerdictCounts()).toEqual({ GREEN: 22, YELLOW: 5, RED: 0 });
  });
});
