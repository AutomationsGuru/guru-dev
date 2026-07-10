import { z } from "zod";

import { VerdictSchema } from "../core/types.js";

export const ToolParityCategorySchema = z.enum([
  "base-tool",
  "honcho-memory",
  "mcp-bridge",
  "research",
  "provider-cli",
  "desktop",
  "repo-routing"
]);
export type ToolParityCategory = z.infer<typeof ToolParityCategorySchema>;

export const ToolParityStatusSchema = z.enum(["native-equivalent", "partial-equivalent", "absent"]);
export type ToolParityStatus = z.infer<typeof ToolParityStatusSchema>;

export const ToolParityRowSchema = z
  .object({
    toolId: z.string().trim().min(1),
    category: ToolParityCategorySchema,
    requirementIds: z.array(z.string().trim().min(1)).min(1),
    currentGuruHarnessToolIds: z.array(z.string().trim().min(1)).default([]),
    status: ToolParityStatusSchema,
    verdict: VerdictSchema,
    ownerModule: z.string().trim().min(1),
    notes: z.string().trim().min(1),
    nextAction: z.string().trim().min(1)
  })
  .strict();
export type ToolParityRow = z.infer<typeof ToolParityRowSchema>;

export const ToolParityManifestSchema = z
  .object({
    generatedBy: z.literal("dev3-wave0-tool-parity-map"),
    sourceRequirementIds: z.array(z.string().trim().min(1)).min(1),
    rows: z.array(ToolParityRowSchema).min(1)
  })
  .strict();
export type ToolParityManifest = z.infer<typeof ToolParityManifestSchema>;

export const TOOL_PARITY_ROWS: readonly ToolParityRow[] = [
  {
    toolId: "read",
    category: "base-tool",
    requirementIds: ["FR-08", "TR-19"],
    currentGuruHarnessToolIds: ["read"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/readTool.ts",
    notes: "Reference-equivalent read tool with offset/limit, binary/secret guards, and repo containment is folded and registered live.",
    nextAction: "Read parity met; extend with image/sidecar reads later if needed."
  },
  {
    toolId: "bash",
    category: "base-tool",
    requirementIds: ["FR-08", "TR-19"],
    currentGuruHarnessToolIds: ["bash", "shell.command.run"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/bashTool.ts",
    notes: "Reference-equivalent bash tool (cwd containment, allowlist, timeout, truncation, dry-run) folded and registered; shell.command.run remains as guarded primitive.",
    nextAction: "Bash parity met; monitor allowlist coverage during dogfood."
  },
  {
    toolId: "edit",
    category: "base-tool",
    requirementIds: ["FR-08", "TR-19"],
    currentGuruHarnessToolIds: ["edit", "fs.edit.apply"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/exactEditTool.ts",
    notes: "Reference-equivalent exact-edit tool (uniqueness validation, dry-run, secret/path guards) folded and registered live.",
    nextAction: "Edit parity met."
  },
  {
    toolId: "write",
    category: "base-tool",
    requirementIds: ["FR-08", "TR-19"],
    currentGuruHarnessToolIds: ["write", "fs.edit.apply"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/writeTool.ts",
    notes: "Reference-equivalent write tool (parent-dir creation, overwrite policy, dry-run, secret guards) folded and registered live.",
    nextAction: "Write parity met."
  },
  {
    toolId: "honcho_memory_status",
    category: "honcho-memory",
    requirementIds: ["FR-09", "FR-11", "TR-29"],
    currentGuruHarnessToolIds: ["honcho_memory_status"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/honcho",
    notes: "Honcho readiness client + honcho_memory_status tool live (env-NAME presence readiness; extension-host registered 2026-07-01).",
    nextAction: "Maintained. Networked Honcho backend (beyond readiness + in-memory) remains a later phase."
  },
  {
    toolId: "honcho_remember",
    category: "honcho-memory",
    requirementIds: ["FR-09", "FR-11", "TR-29"],
    currentGuruHarnessToolIds: ["honcho_remember"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/honcho",
    notes: "honcho_remember live with writeEnabled+userApproved dual gate + secret detection; durable L1 file memory (memory_remember) shipped 2026-07-04.",
    nextAction: "Maintained. Point at a real Honcho backend when networked memory lands (L3 replay)."
  },
  {
    toolId: "honcho_recall",
    category: "honcho-memory",
    requirementIds: ["FR-09", "FR-11", "TR-29"],
    currentGuruHarnessToolIds: ["honcho_recall"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/honcho",
    notes: "honcho_recall live (terms/peer/limit/reasoning levels, in-memory client); L1 memory adds boot-injected recall + memory_search.",
    nextAction: "Maintained. Swap in the networked client behind the same interface later."
  },
  {
    toolId: "honcho_context",
    category: "honcho-memory",
    requirementIds: ["FR-09", "FR-11", "TR-29"],
    currentGuruHarnessToolIds: ["honcho_context"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/honcho",
    notes: "honcho_context live (compact snapshot, maxTokens); boot memory injection covers the always-on context path.",
    nextAction: "Maintained. Networked backend later."
  },
  {
    toolId: "honcho_log_turn",
    category: "honcho-memory",
    requirementIds: ["FR-09", "FR-11", "TR-29"],
    currentGuruHarnessToolIds: ["honcho_log_turn"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/honcho",
    notes: "honcho_log_turn live with the same dual write gate; session persistence events cover the timeline path.",
    nextAction: "Maintained. Networked backend later."
  },
  {
    toolId: "mcp_bridge_status",
    category: "mcp-bridge",
    requirementIds: ["FR-09", "FR-10", "TR-21", "TR-22"],
    currentGuruHarnessToolIds: ["mcp.* (via attachConfiguredMcpServers)"],
    status: "partial-equivalent",
    verdict: "YELLOW",
    ownerModule: "src/mcp",
    notes: "stdio MCP attach + toolBridge ships tools as mcp.<server>.<name>; dedicated status tool is still implicit via attach statuses.",
    nextAction: "Optional: first-class mcp_status tool for operators; bridge is live for configured servers."
  },
  {
    toolId: "mcp_list_tools",
    category: "mcp-bridge",
    requirementIds: ["FR-09", "FR-10", "TR-21", "TR-22"],
    currentGuruHarnessToolIds: ["discoverMcpTools"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/mcp/toolBridge.ts",
    notes: "tools/list is discovered on attach and registered into the session registry.",
    nextAction: "Maintained."
  },
  {
    toolId: "mcp_call_tool",
    category: "mcp-bridge",
    requirementIds: ["FR-09", "FR-10", "TR-21", "TR-22"],
    currentGuruHarnessToolIds: ["mcp.<server>.<tool>"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/mcp/toolBridge.ts",
    notes: "Bridged tools call through the same registry/mandate choke point as builtins.",
    nextAction: "Maintained."
  },
  {
    toolId: "web_fetch",
    category: "research",
    requirementIds: ["FR-09", "TR-20", "TR-36"],
    currentGuruHarnessToolIds: ["web_fetch"],
    status: "partial-equivalent",
    verdict: "YELLOW",
    ownerModule: "src/tools/builtins/webFetchTool.ts",
    notes: "Bounded http(s) GET with size/timeout/redirect caps and net mandate verb. Not a full research agent (no citations engine).",
    nextAction: "Optional: HTML→markdown polish; pair with web_search for discovery."
  },
  {
    toolId: "web_search",
    category: "research",
    requirementIds: ["FR-09", "TR-20", "TR-36"],
    currentGuruHarnessToolIds: ["web_search"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/webSearchTool.ts",
    notes: "DuckDuckGo HTML search (no API key): title/url/snippet hits with size/timeout caps and net mandate.",
    nextAction: "Maintained; optional provider adapters (Brave/Perplexity) behind the same schema later."
  },
  {
    toolId: "todo_write",
    category: "base-tool",
    requirementIds: ["FR-08", "TR-19"],
    currentGuruHarnessToolIds: ["todo_write", "todo_list"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/todoTools.ts",
    notes: "Session task board for multi-step agent work; /todo for operator visibility.",
    nextAction: "Maintained."
  },
  {
    toolId: "perplexity_research",
    category: "research",
    requirementIds: ["FR-09", "TR-20", "TR-36"],
    currentGuruHarnessToolIds: ["web_search", "web_fetch"],
    status: "partial-equivalent",
    verdict: "YELLOW",
    ownerModule: "src/tools/builtins/webSearchTool.ts",
    notes: "Full Perplexity Agent API not shipped; web_search + web_fetch cover discovery + open-page research.",
    nextAction: "Add a schema-first paid research adapter if authorized."
  },
  {
    toolId: "provider_cli_status",
    category: "provider-cli",
    requirementIds: ["FR-09", "FR-17", "TR-23"],
    currentGuruHarnessToolIds: ["provider_cli_status"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/providerCliTools.ts",
    notes: "Agent tool wraps getProviderCliStatusMatrix; default executor PATH-probes via which/where and runs --version with timeout.",
    nextAction: "Maintained; extend inventory when new provider CLIs land."
  },
  {
    toolId: "provider_cli_run",
    category: "provider-cli",
    requirementIds: ["FR-09", "FR-17", "TR-23"],
    currentGuruHarnessToolIds: ["provider_cli_run"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/providerCliTools.ts",
    notes: "Dry-run-first delegated run: status-only policy never lives; live runs need policy explicit-run-allowed + dryRun=false + userApproved=true; output redaction on by default.",
    nextAction: "Optional: CLI-specific argv adapters (stdin prompts, model flags) as dogfood demands."
  },
  {
    toolId: "pyautogui_status",
    category: "desktop",
    requirementIds: ["FR-09", "FR-18", "TR-25"],
    currentGuruHarnessToolIds: [],
    status: "absent",
    verdict: "RED",
    ownerModule: "src/desktop",
    notes: "No PyAutoGUI/computer-use readiness status exists yet.",
    nextAction: "Implement desktop status schemas and later guarded PyAutoGUI adapter."
  },
  {
    toolId: "pyautogui_screen",
    category: "desktop",
    requirementIds: ["FR-09", "FR-18", "TR-25"],
    currentGuruHarnessToolIds: [],
    status: "absent",
    verdict: "RED",
    ownerModule: "src/desktop",
    notes: "No guarded screen size/position/screenshot/locate contract exists yet.",
    nextAction: "Implement screen action schemas with confirmation and sidecar screenshot policy."
  },
  {
    toolId: "pyautogui_mouse",
    category: "desktop",
    requirementIds: ["FR-09", "FR-18", "TR-25"],
    currentGuruHarnessToolIds: [],
    status: "absent",
    verdict: "RED",
    ownerModule: "src/desktop",
    notes: "No guarded mouse action contract exists yet.",
    nextAction: "Implement mouse action schemas with bounds, failsafe, confirmation, and dry-run controls."
  },
  {
    toolId: "pyautogui_keyboard",
    category: "desktop",
    requirementIds: ["FR-09", "FR-18", "TR-25"],
    currentGuruHarnessToolIds: [],
    status: "absent",
    verdict: "RED",
    ownerModule: "src/desktop",
    notes: "No guarded keyboard action contract exists yet.",
    nextAction: "Implement keyboard schemas with risky-hotkey and no-secret-typing gates."
  },
  {
    toolId: "repo_route_lookup",
    category: "repo-routing",
    requirementIds: ["FR-09", "FR-20", "TR-24", "TR-37"],
    currentGuruHarnessToolIds: ["repo.context.resolve"],
    status: "partial-equivalent",
    verdict: "YELLOW",
    ownerModule: "src/repo",
    notes: "Current repo.context.resolve resolves git root/status and AGENTS chain, but lacks repo id/name/category/worktree lookup, workspace maps, ambiguity handling, and governed path awareness.",
    nextAction: "Expand repo routing/capture in Dev 3 D3.7 and keep current repo.context.resolve as the initial compatibility base."
  },
  {
    toolId: "ask_question",
    category: "base-tool",
    requirementIds: ["FR-08", "TR-19"],
    currentGuruHarnessToolIds: ["ask_question"],
    status: "native-equivalent",
    verdict: "GREEN",
    ownerModule: "src/tools/builtins/askQuestionTool.ts",
    notes: "Operator multi-choice Q&A (TTY readline default; inject onAsk for rich TUI). Headless returns interactive:false with empty answers.",
    nextAction: "Optional: native composer overlay instead of readline when TUI is live."
  }
];

export const TOOL_PARITY_MANIFEST: ToolParityManifest = {
  generatedBy: "dev3-wave0-tool-parity-map",
  sourceRequirementIds: ["FR-08", "FR-09", "FR-10", "FR-11", "FR-17", "FR-18", "FR-20", "TR-19", "TR-20", "TR-21", "TR-22", "TR-23", "TR-24", "TR-25", "TR-29", "TR-36", "TR-37", "TR-38"],
  rows: [...TOOL_PARITY_ROWS]
};

export function getToolParityRows(): readonly ToolParityRow[] {
  return TOOL_PARITY_ROWS;
}

export function findToolParityRow(toolId: string): ToolParityRow | undefined {
  return TOOL_PARITY_ROWS.find((row) => row.toolId === toolId);
}

export function getToolParityVerdictCounts(): Readonly<Record<"GREEN" | "YELLOW" | "RED", number>> {
  return TOOL_PARITY_ROWS.reduce(
    (counts, row) => ({
      ...counts,
      [row.verdict]: counts[row.verdict] + 1
    }),
    { GREEN: 0, YELLOW: 0, RED: 0 }
  );
}

export function validateToolParityManifest(manifest: ToolParityManifest = TOOL_PARITY_MANIFEST): ToolParityManifest {
  return ToolParityManifestSchema.parse(manifest);
}
