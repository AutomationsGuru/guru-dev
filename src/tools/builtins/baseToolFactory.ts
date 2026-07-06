import type { ToolDefinition } from "../registry.js";
import { createPiBashTool, type PiBashToolOptions } from "./bashTool.js";
import { createPiExactEditTool, type PiExactEditToolOptions } from "./exactEditTool.js";
import { createPiReadTool, type PiReadToolOptions } from "./readTool.js";
import { createPiWriteTool, type PiWriteToolOptions } from "./writeTool.js";
import { createGlobTool, createGrepTool, createLsTool } from "./searchTools.js";

export interface BaseToolFactoryOptions {
  readonly read?: PiReadToolOptions;
  readonly write?: PiWriteToolOptions;
  readonly edit?: PiExactEditToolOptions;
  readonly bash?: PiBashToolOptions;
}

export function createBaseTools(options: BaseToolFactoryOptions = {}): readonly ToolDefinition[] {
  return [
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
}
