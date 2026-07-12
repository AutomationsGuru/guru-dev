import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

import { z } from "zod";

import { executeCommand, type CommandExecutor } from "../../review/gates.js";
import type { ToolDefinition } from "../registry.js";

export const ReadDiagnosticsToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    paths: z
      .array(z.string().trim().min(1))
      .optional()
      .describe("Optional repo-relative paths to filter diagnostics (files or directories).")
  })
  .strict();

export const ReadDiagnosticsToolOutputSchema = z
  .object({
    diagnostics: z.array(
      z.object({
        file: z.string(),
        line: z.number().int().nonnegative(),
        column: z.number().int().nonnegative(),
        severity: z.enum(["error", "warning"]),
        code: z.string(),
        message: z.string()
      })
    ),
    summary: z.string(),
    exitCode: z.number().int().nullable()
  })
  .strict();

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.*)$/u;

export interface ReadDiagnosticsToolOptions {
  readonly executor?: CommandExecutor;
}

async function resolveTypecheckCommand(repoRoot: string): Promise<readonly string[]> {
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.typecheck) {
        return ["npm", "run", "typecheck"];
      }
    } catch {
      // fall through
    }
  }
  return ["npx", "tsc", "--noEmit"];
}

function parseTscDiagnostics(text: string): z.infer<typeof ReadDiagnosticsToolOutputSchema>["diagnostics"] {
  const out: z.infer<typeof ReadDiagnosticsToolOutputSchema>["diagnostics"] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = TSC_LINE.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, file, lineNo, col, severity, code, message] = match;
    out.push({
      file: file!,
      line: Number(lineNo),
      column: Number(col),
      severity: severity as "error" | "warning",
      code: `TS${code}`,
      message: message!
    });
  }
  return out;
}

function normalizeRepoPath(repoRoot: string, candidate: string): string {
  const abs = resolve(repoRoot, candidate);
  return normalize(relative(repoRoot, abs)).replace(/\\/gu, "/");
}

function matchesPathFilter(repoRoot: string, file: string, filters: readonly string[] | undefined): boolean {
  if (!filters?.length) {
    return true;
  }
  const normalizedFile = normalizeRepoPath(repoRoot, file);
  return filters.some((filter) => {
    const normalizedFilter = normalizeRepoPath(repoRoot, filter);
    return normalizedFile === normalizedFilter || normalizedFile.startsWith(`${normalizedFilter}/`);
  });
}

export function createReadDiagnosticsTool(options: ReadDiagnosticsToolOptions = {}): ToolDefinition<
  typeof ReadDiagnosticsToolInputSchema,
  typeof ReadDiagnosticsToolOutputSchema
> {
  const executor = options.executor ?? executeCommand;
  return {
    id: "read_diagnostics",
    title: "Read diagnostics",
    description:
      "Run the repo typecheck and return structured TypeScript diagnostics. Optionally filter to specific paths (Cursor ReadLints parity).",
    inputSchema: ReadDiagnosticsToolInputSchema,
    outputSchema: ReadDiagnosticsToolOutputSchema,
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const command = await resolveTypecheckCommand(repoRoot);
      const result = await executor(command, {
        cwd: repoRoot,
        timeoutMs: 180_000,
        gate: { kind: "validation", name: "read_diagnostics", command, required: false }
      });
      const text = `${result.stdout}\n${result.stderr}`;
      const parsed = parseTscDiagnostics(text).filter((item) => matchesPathFilter(repoRoot, item.file, input.paths));
      const summary =
        parsed.length === 0
          ? result.exitCode === 0
            ? "No TypeScript diagnostics."
            : "Typecheck failed but no structured TS diagnostics were parsed."
          : `${parsed.length} diagnostic(s)${input.paths?.length ? " (path-filtered)" : ""}.`;
      return { diagnostics: parsed, summary, exitCode: result.exitCode };
    }
  };
}
