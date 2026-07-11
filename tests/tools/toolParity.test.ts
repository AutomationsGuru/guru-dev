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
        "honcho_memory_status",
        "honcho_remember",
        "honcho_recall",
        "honcho_context",
        "honcho_log_turn",
        "mcp_bridge_status",
        "mcp_list_tools",
        "mcp_call_tool",
        "perplexity_research",
        "provider_cli_status",
        "provider_cli_run",
        "pyautogui_status",
        "pyautogui_screen",
        "pyautogui_mouse",
        "pyautogui_keyboard",
        "repo_route_lookup"
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

  it("should mark absent integration tools RED with owner modules", () => {
    // honcho_* rows flipped GREEN 2026-07-04 — the evidence engine (Phase G)
    // caught the stale self-model: the tools were built 2026-07-01.
    for (const id of ["mcp_bridge_status", "provider_cli_status", "pyautogui_status", "perplexity_research"]) {
      const row = findToolParityRow(id);

      expect(row).toBeDefined();
      expect(row).toMatchObject({ status: "absent", verdict: "RED" });
      expect(row?.ownerModule).toMatch(/^src\//);
      expect(row?.currentGuruHarnessToolIds).toEqual([]);
    }
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
    expect(getToolParityVerdictCounts()).toEqual({ GREEN: 14, YELLOW: 1, RED: 10 });
  });
});
