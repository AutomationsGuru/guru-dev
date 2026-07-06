import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import { executeCommand, type CommandExecutor } from "../../review/gates.js";
import { guardContent } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";
import { optimizeBashOutput, DEFAULT_BASH_OPTIMIZER_CONFIG, type BashOptimizerConfig } from "../bashOptimizer.js";

export const PiBashToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000),
    maxOutputBytes: z.number().int().positive().max(1_000_000).default(64_000),
    dryRun: z.boolean().default(true)
  })
  .strict();

export const PiBashToolOutputSchema = z
  .object({
    executed: z.boolean(),
    dryRun: z.boolean(),
    command: z.array(z.string()),
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    truncated: z.boolean().default(false),
    /** True when the child was KILLED (timeout/abort); stdout/stderr are partial. */
    cancelled: z.boolean().default(false),
    durationMs: z.number().int().nonnegative().optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export interface PiBashToolOptions {
  readonly executor?: CommandExecutor;
  readonly shellAllowlist: readonly string[];
  readonly secretAllowList?: readonly string[];
  /** Token optimizer (ADR 2026-07-05): default OFF; never-worse guarded. */
  readonly optimizer?: BashOptimizerConfig;
}

export function createPiBashTool(options: PiBashToolOptions = { shellAllowlist: [] }): ToolDefinition<typeof PiBashToolInputSchema, typeof PiBashToolOutputSchema> {
  const executor = options.executor ?? executeCommand;
  return {
    id: "bash",
    title: "Run bash command",
    description:
      "Bounded command runner (cwd containment, allowlist, timeout, truncation). Pass the full command line in `command` (e.g. \"npm test\") or executable + args separately.",
    inputSchema: PiBashToolInputSchema,
    outputSchema: PiBashToolOutputSchema,
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const cwd = resolve(repoRoot, input.cwd ?? ".");
      // Models routinely pass the whole command line in `command` ("npm test").
      // Without this, "npm test" is treated as an executable NAME and blocked by the
      // allowlist — a silent no-op the model cannot diagnose (found in the 2026-07-02
      // real-task shakedown). Quote-aware split when no separate args were given.
      const command =
        input.args.length === 0 && /\s/u.test(input.command.trim())
          ? splitCommandLine(input.command)
          : [input.command, ...input.args];
      const blockers = buildBlockers(command, cwd, repoRoot, options);
      if (blockers.length > 0) {
        return { executed: false, dryRun: input.dryRun, command: redactCommand(command), truncated: false, cancelled: false, blockers, summary: `Bash command blocked by ${blockers.length} policy check(s).` };
      }
      if (input.dryRun) {
        return { executed: false, dryRun: true, command, truncated: false, cancelled: false, blockers: [], summary: "Dry run only; command was not executed." };
      }

      // The executor OWNS the timeout now (ADR 2026-07-05): it kills the child on
      // expiry (SIGTERM / taskkill tree) and resolves with cancelled + partial
      // output. The outer race survives only as a BACKSTOP for injected custom
      // executors that ignore the timeout contract — with grace so it never wins
      // against a kill-capable executor. When the backstop DOES fire, it resolves
      // a cancelled-shaped result (never rejects): the cancelled contract holds
      // even against a hung executor (adversarial review 2026-07-05).
      const result = await runWithTimeout(
        executor(command, { cwd, timeoutMs: input.timeoutMs, gate: { kind: "validation", name: "bash", command, required: true } }),
        input.timeoutMs + 5_000
      ).catch((error: unknown) => ({
        exitCode: null,
        stdout: "",
        stderr: `Backstop timeout: the executor did not resolve within ${input.timeoutMs + 5_000}ms (${error instanceof Error ? error.message : String(error)}).`,
        durationMs: input.timeoutMs + 5_000,
        cancelled: true as const
      }));
      // Token optimizer (config-gated OFF; never-worse guarded): compresses
      // noisy outputs BEFORE the byte truncation so the kept bytes are signal.
      const optimizerConfig = options.optimizer ?? DEFAULT_BASH_OPTIMIZER_CONFIG;
      const optimized = optimizeBashOutput(result.stdout, command, optimizerConfig);
      const stdoutSource = optimized.optimized && optimized.note ? `${optimized.note}\n${optimized.output}` : optimized.output;
      const stdout = truncate(stdoutSource, input.maxOutputBytes);
      const stderr = truncate(result.stderr, input.maxOutputBytes);
      const decision = guardContent(
        [
          { name: "stdout", value: stdout.value },
          { name: "stderr", value: stderr.value }
        ],
        { repoRoot, riskyPathPatterns: [], secretAllowList: options.secretAllowList ?? [], allowRiskyPaths: false }
      );
      const redacted = !decision.allowed;
      const cancelled = result.cancelled === true;
      return {
        executed: true,
        dryRun: false,
        command,
        exitCode: result.exitCode,
        stdout: redacted ? "[redacted: sensitive output detected]" : stdout.value,
        stderr: redacted ? "[redacted: sensitive output detected]" : stderr.value,
        truncated: stdout.truncated || stderr.truncated,
        cancelled,
        durationMs: result.durationMs,
        blockers: [...decision.blockers],
        summary: cancelled
          ? "Command was KILLED (timeout/abort) — stdout/stderr contain the partial output captured before the kill."
          : redacted
            ? "Command completed, but output was redacted."
            : result.exitCode === 0
              ? "Command completed successfully."
              : "Command completed with a non-zero or null exit code."
      };
    }
  };
}

function buildBlockers(command: readonly string[], cwd: string, repoRoot: string, options: PiBashToolOptions): string[] {
  const blockers: string[] = [];
  const [exe, ...args] = command;
  const allowed = new Set(options.shellAllowlist.map((item) => item.toLowerCase()));
  if (!exe || !allowed.has(exe.toLowerCase())) blockers.push("Executable is not allowlisted by runtime hardening policy.");
  const rel = relative(repoRoot, cwd);
  if (rel.startsWith("..") || isAbsolute(rel)) blockers.push("Command cwd escapes the repository root (path redacted).");
  const content = guardContent(command.map((value, index) => ({ name: `command[${index}]`, value })), { repoRoot, riskyPathPatterns: [], secretAllowList: options.secretAllowList ?? [], allowRiskyPaths: false });
  blockers.push(...content.blockers);
  if (args.some((arg) => /(?:password|token|secret|api[_-]?key)=/iu.test(arg))) blockers.push("Command argument appears to contain an inline secret assignment (value redacted)." );
  return blockers;
}

function redactCommand(command: readonly string[]): string[] {
  const [exe, ...args] = command;
  return exe ? [exe, ...args.map(() => "[redacted]")] : [];
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function truncate(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { value, truncated: false };
  return { value: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Quote-aware whitespace tokenizer for full command lines ("npm test", 'git commit -m "x y"'). */
function splitCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
