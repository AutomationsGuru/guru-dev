import { z } from "zod";

import {
  createDesktopAdapter,
  type DesktopAdapter,
  type DesktopAdapterOptions
} from "../../desktop/adapter.js";
import {
  DesktopKeyboardRequestSchema,
  DesktopKeyboardResultSchema,
  DesktopMouseRequestSchema,
  DesktopMouseResultSchema,
  DesktopScreenRequestSchema,
  DesktopScreenResultSchema,
  DesktopStatusReportSchema
} from "../../desktop/schemas.js";
import type { ToolDefinition } from "../registry.js";

/**
 * PyAutoGUI-class desktop tools — guarded, dry-run-first computer-use surface.
 */

const StatusInputSchema = z.object({}).strict();

export interface DesktopToolsOptions extends DesktopAdapterOptions {
  readonly adapter?: DesktopAdapter;
}

function resolveAdapter(options: DesktopToolsOptions): DesktopAdapter {
  return options.adapter ?? createDesktopAdapter(options);
}

export function createDesktopTools(options: DesktopToolsOptions = {}): readonly ToolDefinition[] {
  const adapter = resolveAdapter(options);

  const statusTool: ToolDefinition<typeof StatusInputSchema, typeof DesktopStatusReportSchema> = {
    id: "pyautogui_status",
    title: "Desktop status",
    description:
      "Report desktop/computer-use readiness: display session, backend injection, failsafe, and whether live mouse/keyboard are enabled (GURU_DESKTOP_LIVE).",
    inputSchema: StatusInputSchema,
    outputSchema: DesktopStatusReportSchema,
    async execute() {
      return adapter.status();
    }
  };

  const screenTool: ToolDefinition<typeof DesktopScreenRequestSchema, typeof DesktopScreenResultSchema> = {
    id: "pyautogui_screen",
    title: "Desktop screen",
    description:
      "Screen size/position/screenshot/locate. Default dryRun=true. Screenshots write to a sidecar path (no inline binary). Live actions need backend + GURU_DESKTOP_LIVE + userApproved.",
    inputSchema: DesktopScreenRequestSchema,
    outputSchema: DesktopScreenResultSchema,
    async execute(input) {
      return await adapter.screen(input);
    }
  };

  const mouseTool: ToolDefinition<typeof DesktopMouseRequestSchema, typeof DesktopMouseResultSchema> = {
    id: "pyautogui_mouse",
    title: "Desktop mouse",
    description:
      "Move/click/scroll with bounds clamp and failsafe corners. Default dryRun=true. Live requires injected backend + GURU_DESKTOP_LIVE + userApproved.",
    inputSchema: DesktopMouseRequestSchema,
    outputSchema: DesktopMouseResultSchema,
    async execute(input) {
      return await adapter.mouse(input);
    }
  };

  const keyboardTool: ToolDefinition<
    typeof DesktopKeyboardRequestSchema,
    typeof DesktopKeyboardResultSchema
  > = {
    id: "pyautogui_keyboard",
    title: "Desktop keyboard",
    description:
      "Type text or send hotkeys. Blocks secret-shaped typing and risky chords (Alt+F4, Win+L, …). Default dryRun=true. Live needs backend + GURU_DESKTOP_LIVE + userApproved.",
    inputSchema: DesktopKeyboardRequestSchema,
    outputSchema: DesktopKeyboardResultSchema,
    async execute(input) {
      return await adapter.keyboard(input);
    }
  };

  return [statusTool, screenTool, mouseTool, keyboardTool];
}
