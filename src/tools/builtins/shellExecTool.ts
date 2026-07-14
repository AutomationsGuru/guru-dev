import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import { executeCommand, type CommandExecutor } from "../../review/gates.js";
import { guardContent, type ToolPolicy } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";

export const ShellExecToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    command: z.array(z.string().trim().min(1)).min(1),
    cwd: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000),
    dryRun: z.boolean().default(true)
  })
  .strict();

export const ShellExecToolOutputSchema = z
  .object({
    executed: z.boolean(),
    dryRun: z.boolean(),
    command: z.array(z.string()),
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    /** True when the child was KILLED (timeout/abort); stdout/stderr are partial. */
    cancelled: z.boolean().default(false),
    durationMs: z.number().int().nonnegative().optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export type ShellExecToolInput = z.infer<typeof ShellExecToolInputSchema>;
export type ShellExecToolOutput = z.infer<typeof ShellExecToolOutputSchema>;

export interface ShellExecToolOptions {
  readonly executor?: CommandExecutor;
  readonly shellAllowlist: readonly string[];
  readonly repoRoot?: string;
  readonly secretAllowList?: readonly string[];
}

export function createShellExecTool(
  options: ShellExecToolOptions = { shellAllowlist: [] }
): ToolDefinition<typeof ShellExecToolInputSchema, typeof ShellExecToolOutputSchema> {
  const executor = options.executor ?? executeCommand;

  return {
    id: "shell.command.run",
    title: "Run bounded shell command",
    description: "Run a policy-permitted command with shell:false, repository cwd containment, secret checks, and dry-run by default.",
    inputSchema: ShellExecToolInputSchema,
    outputSchema: ShellExecToolOutputSchema,
    async execute(input, context) {
      const repoRoot = resolve(input.repoRoot);
      const cwd = resolve(repoRoot, input.cwd ?? ".");
      const blockers = buildShellBlockers(input, cwd, repoRoot, options);

      if (blockers.length > 0) {
        return {
          executed: false,
          dryRun: input.dryRun,
          command: redactCommand(input.command),
          cancelled: false,
          blockers,
          summary: `Shell command blocked by ${blockers.length} policy check(s).`
        };
      }

      if (input.dryRun) {
        return {
          executed: false,
          dryRun: true,
          command: input.command,
          cancelled: false,
          blockers: [],
          summary: "Dry run only; command was not executed."
        };
      }

      // Executor owns timeout (kills child + cancelled + partial). Outer race is a
      // backstop for custom executors that ignore the contract — resolves cancelled,
      // never rejects (parity with bash). Forward operator abort so cancel is immediate.
      const timeoutResult = await runWithTimeout(
        executor(input.command, {
          cwd,
          timeoutMs: input.timeoutMs,
          gate: {
            kind: "validation",
            name: "shell.command.run",
            command: input.command,
            required: true
          },
          ...(context?.signal ? { signal: context.signal } : {})
        }),
        input.timeoutMs + 5_000
      ).catch((error: unknown) => ({
        exitCode: null as number | null,
        stdout: "",
        stderr: `Backstop timeout: the executor did not resolve within ${input.timeoutMs + 5_000}ms (${error instanceof Error ? error.message : String(error)}).`,
        durationMs: input.timeoutMs + 5_000,
        cancelled: true as const
      }));

      const outputDecision = guardContent(
        [
          { name: "stdout", value: timeoutResult.stdout },
          { name: "stderr", value: timeoutResult.stderr }
        ],
        {
          repoRoot,
          riskyPathPatterns: [],
          secretAllowList: options.secretAllowList ?? [],
          allowRiskyPaths: false
        }
      );
      const redactedOutput = !outputDecision.allowed;
      const cancelled = timeoutResult.cancelled === true;

      return {
        executed: true,
        dryRun: false,
        command: input.command,
        exitCode: timeoutResult.exitCode,
        stdout: redactedOutput ? "[redacted: sensitive output detected]" : timeoutResult.stdout,
        stderr: redactedOutput ? "[redacted: sensitive output detected]" : timeoutResult.stderr,
        cancelled,
        durationMs: timeoutResult.durationMs,
        blockers: [...outputDecision.blockers],
        summary: cancelled
          ? "Command was KILLED (timeout/abort) — stdout/stderr contain the partial output captured before the kill."
          : redactedOutput
            ? "Command completed, but output was redacted by sensitive-output policy."
            : timeoutResult.exitCode === 0
              ? "Command completed successfully."
              : "Command completed with a non-zero or null exit code."
      };
    }
  };
}

function redactCommand(command: readonly string[]): string[] {
  const [executable, ...args] = command;

  return executable ? [executable, ...args.map(() => "[redacted]")] : [];
}

function buildShellBlockers(
  input: ShellExecToolInput,
  cwd: string,
  repoRoot: string,
  options: ShellExecToolOptions
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
    blockers.push("Command arguments starting with '-' are blocked unless explicitly mediated by a higher-level tool.");
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

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
