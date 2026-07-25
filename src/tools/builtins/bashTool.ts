import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import { executeCommand, requiresWindowsCommandShim, type CommandExecutor } from "../../review/gates.js";
import { guardContent } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";
import { optimizeBashOutput, DEFAULT_BASH_OPTIMIZER_CONFIG, type BashOptimizerConfig } from "../bashOptimizer.js";
import { TOOL_ERROR_CODES, renderOutputSummary, summarizeLines, truncateUtf8 } from "../ergonomics.js";
import { spawnBackgroundTask } from "./backgroundTaskRegistry.js";

export const PiBashToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000),
    maxOutputBytes: z.number().int().positive().max(1_000_000).default(64_000),
    background: z.boolean().optional().describe("Start the validated command as a managed background task. Defaults to false."),
    dryRun: z.boolean().default(true)
  })
  .strict();

export const PiBashToolOutputSchema = z
  .object({
    executed: z.boolean(),
    dryRun: z.boolean(),
    background: z.boolean().default(false),
    command: z.array(z.string()),
    taskId: z.string().trim().min(1).optional(),
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    /** Original pre-truncation sizes so the model sees the aggregate, not the dump. */
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    stdoutLines: z.number().int().nonnegative().optional(),
    stderrLines: z.number().int().nonnegative().optional(),
    /** Stable machine-readable failure code; null on a clean run. */
    errorCode: z.string().nullable().default(null),
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
  /** Injectable managed-task launcher; production uses the shared manage_task registry. */
  readonly startBackground?: (command: readonly string[], cwd: string) => string | Promise<string>;
  readonly shellAllowlist: readonly string[];
  readonly secretAllowList?: readonly string[];
  /** Token optimizer (ADR 2026-07-05): default OFF; never-worse guarded. */
  readonly optimizer?: BashOptimizerConfig;
}

export function createPiBashTool(options: PiBashToolOptions = { shellAllowlist: [] }): ToolDefinition<typeof PiBashToolInputSchema, typeof PiBashToolOutputSchema> {
  const executor = options.executor ?? executeCommand;
  const startBackground = options.startBackground ?? spawnBackgroundTask;
  return {
    id: "bash",
    title: "Run command (argv)",
    description:
      "Bounded single-process argv runner (cwd containment, executable policy, timeout, truncation) with optional managed background launch. Pass a simple command line (e.g. \"npm test\") or executable + args separately. " +
      "Shell operators, redirects, pipes, expansion, and command chaining are intentionally unsupported; issue separate tool calls instead. " +
      "Before any destructive/delete command (rm, a truncating `>` redirect, git reset --hard, force-push), ask: does this really need to go? (yes/no) " +
      "Preserve, rename-aside, or enhance before you delete — destructive commands are double-checked even in YOLO.",
    inputSchema: PiBashToolInputSchema,
    outputSchema: PiBashToolOutputSchema,
    async execute(input, context) {
      const repoRoot = resolve(input.repoRoot);
      const cwd = resolve(repoRoot, input.cwd ?? ".");
      // Models routinely pass the whole command line in `command` ("npm test").
      // Without this, "npm test" is treated as an executable NAME and blocked by the
      // allowlist — a silent no-op the model cannot diagnose (found in the 2026-07-02
      // real-task shakedown). Quote-aware split when no separate args were given.
      const parsed = input.args.length === 0 ? parseCommandLine(input.command) : { command: [input.command, ...input.args] };
      const command = parsed.command;
      // Validate the FINAL argv, including tokens produced by quote-aware
      // splitting. On Windows bare npm/git/etc. run through cmd.exe to reach
      // their .cmd shims, so stripped quotes must never expose cmd metasyntax.
      const argvSyntaxBlocker = command[0] !== undefined && requiresWindowsCommandShim(command[0]) && command.some(containsUnsupportedShellSyntax)
        ? SHELL_SYNTAX_BLOCKER
        : undefined;
      const blockers = [
        ...(parsed.blocker ? [parsed.blocker] : []),
        ...(argvSyntaxBlocker ? [argvSyntaxBlocker] : []),
        ...buildBlockers(command, cwd, repoRoot, options)
      ];
      if (blockers.length > 0) {
        return { executed: false, dryRun: input.dryRun, background: input.background === true, command: redactCommand(command), errorCode: TOOL_ERROR_CODES.POLICY_BLOCKED, truncated: false, cancelled: false, blockers, summary: `Bash command blocked by ${blockers.length} policy check(s).` };
      }
      if (input.dryRun) {
        return { executed: false, dryRun: true, background: input.background === true, command, errorCode: null, truncated: false, cancelled: false, blockers: [], summary: "Dry run only; command was not executed." };
      }
      if (input.background === true) {
        const taskId = await startBackground(command, cwd);
        return {
          executed: true,
          dryRun: false,
          background: true,
          command,
          taskId,
          errorCode: null,
          truncated: false,
          cancelled: false,
          blockers: [],
          summary: `Background task started as ${taskId}; use manage_task to inspect or control it.`
        };
      }

      // The executor OWNS the timeout now (ADR 2026-07-05): it kills the child on
      // expiry (SIGTERM / taskkill tree) and resolves with cancelled + partial
      // output. The outer race survives only as a BACKSTOP for injected custom
      // executors that ignore the timeout contract — with grace so it never wins
      // against a kill-capable executor. When the backstop DOES fire, it resolves
      // a cancelled-shaped result (never rejects): the cancelled contract holds
      // even against a hung executor (adversarial review 2026-07-05).
      const result = await runWithTimeout(
        executor(command, { cwd, timeoutMs: input.timeoutMs, gate: { kind: "validation", name: "bash", command, required: true }, ...(context?.signal ? { signal: context.signal } : {}) }),
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
      // Ergonomics (IDEA-E2): oversized streams are AGGREGATED, not raw-flooded —
      // the kept payload leads with a line/repetition/width profile so the model
      // sees counts and repeated lines instead of an opaque byte cut. Small
      // outputs pass through untouched.
      const stdout = capStream(stdoutSource, input.maxOutputBytes);
      const stderr = capStream(result.stderr, input.maxOutputBytes);
      const decision = guardContent(
        [
          { name: "stdout", value: stdout.value },
          { name: "stderr", value: stderr.value }
        ],
        { repoRoot, riskyPathPatterns: [], secretAllowList: options.secretAllowList ?? [], allowRiskyPaths: false }
      );
      const redacted = !decision.allowed;
      const cancelled = result.cancelled === true;
      const truncated = stdout.truncated || stderr.truncated;
      const profileNote = truncated ? ` Output truncated from ${stdout.originalBytes + stderr.originalBytes} byte(s) (stdout ${stdout.originalBytes}, stderr ${stderr.originalBytes}); payloads carry an aggregate profile.` : "";
      return {
        executed: true,
        dryRun: false,
        background: false,
        command,
        exitCode: result.exitCode,
        stdout: redacted ? "[redacted: sensitive output detected]" : stdout.value,
        stderr: redacted ? "[redacted: sensitive output detected]" : stderr.value,
        stdoutBytes: stdout.originalBytes,
        stderrBytes: stderr.originalBytes,
        stdoutLines: stdout.lineCount,
        stderrLines: stderr.lineCount,
        errorCode: null,
        truncated,
        cancelled,
        durationMs: result.durationMs,
        blockers: [...decision.blockers],
        summary: cancelled
          ? `Command was KILLED (timeout/abort) — stdout/stderr contain the partial output captured before the kill.${profileNote}`
          : redacted
            ? "Command completed, but output was redacted."
            : result.exitCode === 0
              ? `Command completed successfully.${profileNote}`
              : `Command completed with a non-zero or null exit code.${profileNote}`
      };
    }
  };
}

function buildBlockers(command: readonly string[], cwd: string, repoRoot: string, options: PiBashToolOptions): string[] {
  const blockers: string[] = [];
  const [exe, ...args] = command;
  const allowed = new Set(options.shellAllowlist.map((item) => item.toLowerCase()));
  if (!exe || (!allowed.has("*") && !allowed.has(exe.toLowerCase()))) blockers.push("Executable is not allowlisted by runtime hardening policy.");
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

interface CappedStream {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly lineCount: number;
}

/**
 * Cap one output stream ergonomically (IDEA-E2): within budget the value passes
 * through byte-identical; over budget the payload becomes an aggregate profile
 * (line/byte/repetition/width counts + bounded head excerpt) instead of a raw
 * byte dump. The UTF-8 boundary walk lives in ergonomics.truncateUtf8 (review
 * 2026-07-08 rule: never cut mid-sequence).
 */
function capStream(value: string, maxBytes: number): CappedStream {
  const profile = summarizeLines(value);
  const originalBytes = Buffer.from(value, "utf8").length;
  if (originalBytes <= maxBytes) {
    return { value, truncated: false, originalBytes, lineCount: profile.lineCount };
  }
  const excerpt = truncateUtf8(value, Math.max(1, Math.floor(maxBytes / 2)));
  const aggregated = renderOutputSummary(profile, originalBytes, excerpt.value);
  const capped = truncateUtf8(aggregated, maxBytes);
  return { value: capped.value, truncated: true, originalBytes, lineCount: profile.lineCount };
}

const SHELL_SYNTAX_BLOCKER =
  "Shell operators are not supported by the argv command runner; issue each command as a separate tool call.";

function containsUnsupportedShellSyntax(value: string): boolean {
  return /[\r\n&|;<>`^%!()]/u.test(value);
}

/**
 * Quote-aware tokenizer for one executable invocation. This is deliberately not
 * a shell parser: syntax whose meaning depends on a shell is rejected rather
 * than silently passed as ordinary argv (the old `&&` failure mode).
 */
function parseCommandLine(line: string): { readonly command: string[]; readonly blocker?: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;
  const trimmed = line.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] as string;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
    } else if (char === "\n" || char === "\r" || char === "&" || char === "|" || char === ";" || char === "<" || char === ">" || char === "`") {
      return { command: tokens.length > 0 ? tokens : current.length > 0 ? [current] : [], blocker: SHELL_SYNTAX_BLOCKER };
    } else if (/\s/u.test(char)) {
      if (tokenStarted || current.length > 0) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += char;
      tokenStarted = true;
    }
  }
  if (quote) {
    return { command: tokens.length > 0 ? tokens : current.length > 0 ? [current] : [], blocker: "Command line has an unterminated quote; correct the quoting and retry." };
  }
  if (tokenStarted || current.length > 0) {
    tokens.push(current);
  }
  return { command: tokens };
}
