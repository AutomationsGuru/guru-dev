import { readFileSync } from "node:fs";

export * from "./config/loadConfig.js";
export * from "./config/schema.js";
export * from "./home/paths.js";
export * from "./core/donePacket.js";
export * from "./core/types.js";
export * from "./direction/hereThere.js";
export * from "./dogfood/orchestrators.js";
export * from "./executor/selfBuildExecutor.js";
export * from "./git/prAutomation.js";
export * from "./kernel/selfBuildLoop.js";
export * from "./maintenance/audit.js";
export * from "./model/openAiCompatiblePlannerModel.js";
export * from "./model/schemas.js";
export * from "./operational/schemas.js";
export * from "./operational/store.js";
export * from "./planner/runtime.js";
export * from "./planner/schemas.js";
export * from "./project-harness/bootstrap.js";
export * from "./project-harness/schemas.js";
export * from "./repo/context.js";
export * from "./review/gates.js";
export * from "./mcp/schemas.js";
export * from "./mcp/jsonRpcStdio.js";
export * from "./mcp/client.js";
export * from "./mcp/toolBridge.js";
export * from "./mcp/attach.js";
export * from "./runtime/pathNormalization.js";
export * from "./runtime/persistence.js";
export * from "./selfbuild/runDevCycle.js";
export * from "./selfbuild/runDevCycleLoop.js";
export * from "./selfbuild/selectTask.js";
export * from "./runtime/schemas.js";
export * from "./runtime/session.js";
export * from "./session/agentSession.js";
export * from "./surfaces/api.js";
export * from "./surfaces/rpc.js";
export * from "./surfaces/tui.js";
export * from "./safety/policyGuard.js";
export * from "./skills/loader.js";
export * from "./skills/schemas.js";
export * from "./tui/askPrompt.js";
export * from "./tui/interactionGate.js";
export * from "./tools/builtins/askQuestionTool.js";
export * from "./tools/builtins/fileEditTool.js";
export * from "./tools/builtins/gitPrAutomationTool.js";
export * from "./tools/builtins/githubPrTools.js";
export * from "./tools/builtins/todoTools.js";
export * from "./tools/builtins/webFetchTool.js";
export * from "./tools/builtins/maintenanceAuditTool.js";
export * from "./tools/builtins/manageTaskTool.js";
export * from "./tools/builtins/operationalStoreTools.js";
export * from "./tools/builtins/repoContextTool.js";
export * from "./tools/builtins/reviewGatesTool.js";
export * from "./tools/builtins/scheduleTool.js";
export * from "./tools/builtins/shellExecTool.js";
export * from "./tools/builtins/skillLoaderTools.js";
export * from "./tools/registry.js";

export const GURUHARNESS_RUNTIME_NAME = "GuruHarness";
export const GURUHARNESS_VERSION = readPackageVersion();

export interface RuntimeInfo {
  readonly name: typeof GURUHARNESS_RUNTIME_NAME;
  readonly version: string;
  readonly capability: string;
}

interface PackageMetadata {
  readonly version: string;
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

export function readPackageVersionFromMetadata(packageJson: unknown): string {
  if (!isPackageMetadata(packageJson)) {
    throw new Error("GuruHarness package metadata must include a version string.");
  }

  return packageJson.version;
}

function readPackageVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as unknown;

  return readPackageVersionFromMetadata(packageJson);
}

export function getRuntimeInfo(): RuntimeInfo {
  return {
    name: GURUHARNESS_RUNTIME_NAME,
    version: GURUHARNESS_VERSION,
    capability: "repo-aware agent harness runtime nucleus"
  };
}
