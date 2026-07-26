import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { CommandExecutor } from "../../review/gates.js";
import { guardContent, type ToolPolicy } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";
import {
  DEBUG_LOOP_DEFAULT_MAX_TRIES,
  DEBUG_LOOP_MAX_TRIES_CEILING,
  runDebugLoop,
  type DebugLoopFix,
  type DebugLoopTrialApplier
} from "../debugLoop/runDebugLoop.js";

export const DebugLoopToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    command: z.array(z.string().trim().min(1)).min(1),
    cwd: z.string().trim().min(1).optional(),
    maxTries: z
      .number()
      .int()
      .min(1)
      .max(DEBUG_LOOP_MAX_TRIES_CEILING)
      .default(DEBUG_LOOP_DEFAULT_MAX_TRIES),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000),
    mode: z.enum(["trial", "pending"]).default("trial")
  })
  .strict();

export const DebugLoopAttemptRecordSchema = z
  .object({
    attempt: z.number().int().positive(),
    exitCode: z.number().int().nullable(),
    cancelled: z.boolean(),
    fix: z.object({ summary: z.string(), description: z.string() }).optional(),
    rolledBack: z.boolean()
  })
  .strict();

export const DebugLoopReceiptSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    rollbackPerformed: z.boolean(),
    fixesTried: z.array(
      z
        .object({
          summary: z.string(),
          description: z.string()
        })
        .strict()
    )
  })
  .strict();

export const DebugLoopToolOutputSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed"]),
    executed: z.boolean(),
    mode: z.enum(["trial", "pending"]),
    command: z.array(z.string()),
    tries: z.number().int().nonnegative(),
    maxTries: z.number().int().positive(),
    attempts: z.array(DebugLoopAttemptRecordSchema),
    receipt: DebugLoopReceiptSchema,
    pendingFix: z
      .object({ summary: z.string(), description: z.string() })
      .nullable()
      .optional(),
    blocked: z.boolean().default(false),
    blockers: z.array(z.string()).default([]),
    summary: z.string()
  })
  .strict();

export type DebugLoopToolInput = z.infer<typeof DebugLoopToolInputSchema>;
export type DebugLoopToolOutput = z.infer<typeof DebugLoopToolOutputSchema>;

export interface DebugLoopToolOptions {
  readonly executor?: CommandExecutor;
  readonly proposeFix: (context: {
    readonly attempt: number;
    readonly command: readonly string[];
    readonly stdout: string;
    readonly stderr: string;
  }) => Promise<DebugLoopFix>;
  readonly trialApplier: DebugLoopTrialApplier;
  readonly shellAllowlist: readonly string[];
  readonly repoRoot?: string;
  readonly secretAllowList?: readonly string[];
}

export function createDebugLoopTool(
  options: DebugLoopToolOptions
): ToolDefinition<typeof DebugLoopToolInputSchema, typeof DebugLoopToolOutputSchema> {
  return {
    id: "debug.loop.run",
    title: "Run bounded debug loop",
    description:
      "Run a command, propose fixes on failure, apply a trial under policy, re-run, and stop on success or at maxTries with an explicit fail receipt. Every failed trial is rolled back.",
    effect: "mutating",
    inputSchema: DebugLoopToolInputSchema,
    outputSchema: DebugLoopToolOutputSchema,
    async execute(input, context) {
      if (!options.proposeFix || !options.trialApplier) {
        throw new Error(
          "debug.loop.run is not supported in this runtime environment (no fix proposer or trial applier)."
        );
      }

      const repoRoot = resolve(input.repoRoot);
      const cwd = resolve(repoRoot, input.cwd ?? ".");
      const blockers = buildDebugLoopBlockers(input, cwd, repoRoot, options);

      if (blockers.length > 0) {
        return {
          outcome: "failed",
          executed: false,
          mode: input.mode,
          command: redactCommand(input.command),
          tries: 0,
          maxTries: input.maxTries,
          attempts: [],
          receipt: { attempts: 0, rollbackPerformed: false, fixesTried: [] },
          blocked: true,
          blockers,
          summary: `Blocked: ${blockers[0]}`
        };
      }

      if (input.mode === "pending") {
        return {
          outcome: "failed",
          executed: false,
          mode: "pending",
          command: input.command,
          tries: 0,
          maxTries: input.maxTries,
          attempts: [],
          receipt: { attempts: 0, rollbackPerformed: false, fixesTried: [] },
          pendingFix: { summary: "pending mode not yet implemented", description: "placeholder" },
          blocked: false,
          blockers: [],
          summary: "Pending fix mode is not yet implemented in this packet."
        };
      }

      const result = await runDebugLoop({
        command: input.command,
        cwd,
        maxTries: input.maxTries,
        executor: options.executor,
        proposeFix: async (proposeContext) => {
          const scrubbed = scrubStreams(proposeContext.stdout, proposeContext.stderr, repoRoot, options);
          return options.proposeFix({
            attempt: proposeContext.attempt,
            command: proposeContext.command,
            stdout: scrubbed.stdout,
            stderr: scrubbed.stderr
          });
        },
        trialApplier: options.trialApplier,
        timeoutMs: input.timeoutMs,
        signal: context.signal
      });

      return {
        outcome: result.outcome,
        executed: true,
        mode: "trial",
        command: input.command,
        tries: result.tries,
        maxTries: result.maxTries,
        attempts: result.attempts,
        receipt: result.receipt,
        blocked: false,
        blockers: [],
        summary: result.summary
      };
    }
  };
}

function buildDebugLoopBlockers(
  input: DebugLoopToolInput,
  cwd: string,
  repoRoot: string,
  options: DebugLoopToolOptions
): string[] {
  const blockers: string[] = [];
  const [executable, ...args] = input.command;
  const allowedExecutables = new Set(options.shellAllowlist.map((entry) => entry.toLowerCase()));

  if (!executable || (!allowedExecutables.has("*") && !allowedExecutables.has(executable.toLowerCase()))) {
    blockers.push("Executable is not allowlisted by runtime hardening policy.");
  }

  const relativeCwd = relative(repoRoot, cwd);
  if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
    blockers.push("Command cwd escapes the repository root (path redacted).");
  }

  const unsafeArg = args.find((arg) => arg.startsWith("-"));
  if (unsafeArg) {
    blockers.push(
      "Command arguments starting with '-' are blocked unless explicitly mediated by a higher-level tool."
    );
  }

  const policy: ToolPolicy = {
    repoRoot,
    riskyPathPatterns: [],
    secretAllowList: options.secretAllowList ?? [],
    allowRiskyPaths: false
  };
  const contentDecision = guardContent(
    input.command.map((value, index) => ({ name: `command[${index}]`, value })),
    policy
  );
  blockers.push(...contentDecision.blockers);

  return blockers;
}

function redactCommand(command: readonly string[]): string[] {
  const [executable, ...args] = command;

  return executable ? [executable, ...args.map(() => "[redacted]")] : [];
}

function scrubStreams(
  stdout: string,
  stderr: string,
  repoRoot: string,
  options: DebugLoopToolOptions
): { stdout: string; stderr: string } {
  const policy: ToolPolicy = {
    repoRoot,
    riskyPathPatterns: [],
    secretAllowList: options.secretAllowList ?? [],
    allowRiskyPaths: false
  };
  const decision = guardContent(
    [
      { name: "stdout", value: stdout },
      { name: "stderr", value: stderr }
    ],
    policy
  );

  if (decision.allowed) {
    return { stdout, stderr };
  }

  return {
    stdout: "[redacted: sensitive output detected]",
    stderr: "[redacted: sensitive output detected]"
  };
}
