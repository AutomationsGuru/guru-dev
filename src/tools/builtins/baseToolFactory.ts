import type { ToolDefinition } from "../registry.js";
import { createPiBashTool, type PiBashToolOptions } from "./bashTool.js";
import { createPiExactEditTool, type PiExactEditToolOptions } from "./exactEditTool.js";
import { createPiReadTool, type PiReadToolOptions } from "./readTool.js";
import { createPiWriteTool, type PiWriteToolOptions } from "./writeTool.js";
import { createGlobTool, createGrepTool, createLsTool } from "./searchTools.js";
import { createAskQuestionTool, type AskQuestionToolOptions } from "./askQuestionTool.js";
import { createSearchWebTool, type SearchWebToolOptions } from "./searchWebTool.js";
import { createReadUrlTool, type ReadUrlToolOptions } from "./readUrlTool.js";
import { createScheduleTool, type ScheduleToolOptions } from "./scheduleTool.js";
import { createManageTaskTool, type ManageTaskToolOptions } from "./manageTaskTool.js";
import { createSessionTodosTool } from "./sessionTodosTool.js";
import { createReadDiagnosticsTool, type ReadDiagnosticsToolOptions } from "./readDiagnosticsTool.js";
import { manageBackgroundTask } from "./backgroundTaskRegistry.js";

export interface BaseToolFactoryOptions {
  readonly read?: PiReadToolOptions;
  readonly write?: PiWriteToolOptions;
  readonly edit?: PiExactEditToolOptions;
  readonly bash?: PiBashToolOptions;
  readonly askQuestion?: AskQuestionToolOptions;
  readonly searchWeb?: SearchWebToolOptions;
  readonly readUrl?: ReadUrlToolOptions;
  readonly schedule?: ScheduleToolOptions;
  readonly manageTask?: ManageTaskToolOptions;
  readonly readDiagnostics?: ReadDiagnosticsToolOptions;
}

export function createBaseTools(options: BaseToolFactoryOptions = {}): readonly ToolDefinition<any, any>[] {
  const tools: ToolDefinition<any, any>[] = [
    createPiReadTool(options.read),
    createPiWriteTool(options.write),
    createPiExactEditTool(options.edit),
    createPiBashTool(options.bash),
    // Typed exploration trio (ADR 2026-07-05-every-session-dividends): ~60%
    // cheaper than their raw-bash equivalents, read-only by construction.
    createGrepTool(),
    createGlobTool(),
    createLsTool()
  ];

  tools.push(createAskQuestionTool(options.askQuestion ?? {}));
  tools.push(createSearchWebTool(options.searchWeb ?? {}));
  tools.push(createReadUrlTool(options.readUrl ?? {}));
  tools.push(createScheduleTool(options.schedule ?? {}));
  tools.push(createManageTaskTool(options.manageTask ?? { onManage: manageBackgroundTask }));
  tools.push(createSessionTodosTool());
  tools.push(createReadDiagnosticsTool(options.readDiagnostics ?? {}));

  return tools;
}
