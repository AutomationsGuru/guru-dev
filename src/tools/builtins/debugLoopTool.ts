import { z } from "zod";

import type { ToolDefinition } from "../registry.js";
import {
  runDebugLoop,
  type CommandRunResult,
  type DebugFix,
  type FixProposer,
  type TrialApplier
} from "../debugLoop/runDebugLoop.js";

/**
 * IDEA-F10-DEBUG-LOOP-01 — bounded debug-loop tool.
 *
 * Surfaces {@link runDebugLoop} behind the standard `ToolDefinition` +
 * injectable-backend seam used by monitor/schedule. The backend (command runner,
 * fix proposer, trial applier) is injected by the runtime, so the tool itself
 * carries no model or shell dependency and introduces no implicit spend — the
 * proposer seam is where any model call would live, as an explicit, owned
 * adapter (hard limit #2 — no unapproved spend).
 *
 * The tool is `effect: "mutating"` because a trial applier may edit files; plan
 * mode therefore excludes it by construction from read-only certification.
 */

/** Default iteration ceiling. Mirrors the plan's "maxTries default 5". */
export const DEFAULT_DEBUG_LOOP_MAX_TRIES = 5;

/** Absolute schema ceiling; an explicit, structural bound on the loop. */
export const MAX_DEBUG_LOOP_TRIES = 50;

export const DebugLoopToolInputSchema = z
  .object({
    Command: z
      .string()
      .min(1)
      .describe("The shell command to run on each debug-loop attempt."),
    MaxTries: z
      .number()
      .int()
      .min(1)
      .max(MAX_DEBUG_LOOP_TRIES)
      .optional()
      .describe(`Maximum run attempts before failing closed. Defaults to ${DEFAULT_DEBUG_LOOP_MAX_TRIES}.`)
  })
  .strict();

export const DebugLoopToolOutputSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]).describe("Terminal status of the loop."),
    command: z.string().describe("The command that was run."),
    tries: z.number().int().positive().describe("Number of run attempts actually made."),
    maxTries: z.number().int().positive().describe("The structural ceiling that bounded the loop."),
    message: z.string().describe("Human-readable summary of the terminal state."),
    lastExitCode: z.number().int().nullable().describe("Exit code of the final attempt (null if none)."),
    lastStdout: z.string().describe("Captured stdout of the final attempt."),
    lastStderr: z.string().describe("Captured stderr of the final attempt."),
    lastFix: z
      .object({
        description: z.string(),
        patch: z.string()
      })
      .nullable()
      .describe("The fix attempted on the final iteration, if any.")
  })
  .strict();

export type DebugLoopToolInput = z.infer<typeof DebugLoopToolInputSchema>;
export type DebugLoopToolOutput = z.infer<typeof DebugLoopToolOutputSchema>;

/**
 * Injectable backend. The runtime supplies a real command runner, a fix proposer
 * (model-backed or stub), and a trial applier. Tests pass a deterministic triple.
 */
export interface DebugLoopBackend {
  readonly run: () => Promise<CommandRunResult>;
  readonly propose: FixProposer;
  readonly apply: TrialApplier;
}

export interface DebugLoopToolOptions {
  readonly backend?: DebugLoopBackend;
}

export function createDebugLoopTool(
  options: DebugLoopToolOptions = {}
): ToolDefinition<typeof DebugLoopToolInputSchema, typeof DebugLoopToolOutputSchema> {
  return {
    id: "debug_loop",
    title: "Run Bounded Debug Loop",
    description:
      "Run a command and, on failure, propose and trial a fix, then re-run — up to a bounded maxTries. Returns an explicit success or fail-closed receipt.",
    effect: "mutating",
    inputSchema: DebugLoopToolInputSchema,
    outputSchema: DebugLoopToolOutputSchema,
    async execute(input) {
      if (!options.backend) {
        throw new Error(
          "debug_loop tool is not supported in this runtime environment (no debug-loop backend)."
        );
      }
      const maxTries = input.MaxTries ?? DEFAULT_DEBUG_LOOP_MAX_TRIES;
      const receipt = await runDebugLoop({
        run: options.backend.run,
        propose: options.backend.propose,
        apply: options.backend.apply,
        input: { Command: input.Command, MaxTries: maxTries }
      });
      return {
        status: receipt.status,
        command: receipt.command,
        tries: receipt.tries,
        maxTries: receipt.maxTries,
        message: receipt.message,
        lastExitCode: receipt.lastExitCode,
        lastStdout: receipt.lastStdout,
        lastStderr: receipt.lastStderr,
        lastFix: receipt.lastFix
          ? { description: receipt.lastFix.description, patch: receipt.lastFix.patch }
          : null
      };
    }
  };
}

// Re-export the core engine types for callers that compose the loop directly.
export type { CommandRunResult, DebugFix, FixProposer, TrialApplier } from "../debugLoop/runDebugLoop.js";
