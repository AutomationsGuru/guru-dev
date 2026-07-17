import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "../registry.js";
import {
  createTypeScriptLanguageServerAdapter,
  type TypeScriptLanguageServerAdapter,
  type TypeScriptLanguageServerAdapterOptions
} from "../../lsp/typescriptLanguageServer.js";

export const LspToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    action: z.enum(["status", "diagnostics", "definition", "references", "hover"]),
    path: z.string().trim().min(1).optional(),
    line: z.number().int().nonnegative().optional(),
    character: z.number().int().nonnegative().optional()
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.action !== "status") {
      if (!input.path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `LSP action "${input.action}" requires a file path.`,
          path: ["path"]
        });
        return;
      }
    }
    if (
      input.action === "definition" ||
      input.action === "references" ||
      input.action === "hover"
    ) {
      if (input.line === undefined || input.line === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `LSP action "${input.action}" requires a zero-based line position.`,
          path: ["line"]
        });
      }
      if (input.character === undefined || input.character === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `LSP action "${input.action}" requires a zero-based character position.`,
          path: ["character"]
        });
      }
    }
  });

export type LspToolInput = z.infer<typeof LspToolInputSchema>;

export const LspLocationSchema = z.object({
  path: z.string().optional(),
  uri: z.string().optional(),
  range: z.object({
    start: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }),
    end: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() })
  })
});

export type LspLocation = z.infer<typeof LspLocationSchema>;

export const LspDiagnosticSchema = z.object({
  range: z.object({
    start: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }),
    end: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() })
  }),
  severity: z.number().int().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  source: z.string().optional(),
  message: z.string()
});

export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>;

const LspToolStatusOutputSchema = z.object({
  status: z.literal("available"),
  summary: z.string()
});

const LspToolUnavailableOutputSchema = z.object({
  status: z.literal("unavailable"),
  summary: z.string()
});

const LspToolCompletedDiagnosticsOutputSchema = z.object({
  status: z.literal("completed"),
  summary: z.string(),
  diagnostics: z.array(LspDiagnosticSchema)
});

const LspToolCompletedLocationsOutputSchema = z.object({
  status: z.literal("completed"),
  summary: z.string(),
  locations: z.array(LspLocationSchema)
});

const LspToolCompletedHoverOutputSchema = z.object({
  status: z.literal("completed"),
  summary: z.string(),
  hover: z.string()
});

const LspToolFailedOutputSchema = z.object({
  status: z.literal("failed"),
  summary: z.string()
});

const LspToolNotApplicableOutputSchema = z.object({
  status: z.literal("failed"),
  summary: z.string()
});

export const LspToolOutputSchema = z.discriminatedUnion("status", [
  LspToolStatusOutputSchema,
  LspToolUnavailableOutputSchema,
  LspToolCompletedDiagnosticsOutputSchema,
  LspToolCompletedLocationsOutputSchema,
  LspToolCompletedHoverOutputSchema,
  LspToolFailedOutputSchema,
  LspToolNotApplicableOutputSchema
]);

export type LspToolOutput = z.infer<typeof LspToolOutputSchema>;

export interface LspToolOptions {
  readonly adapter?: TypeScriptLanguageServerAdapter;
  readonly adapterOptions?: TypeScriptLanguageServerAdapterOptions;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

function resolveSafePath(repoRoot: string, inputPath: string): string {
  const canonicalRepo = resolve(repoRoot);
  if (!statSync(canonicalRepo).isDirectory()) {
    throw new Error("LSP repoRoot must be a directory.");
  }
  const candidate = resolve(canonicalRepo, isAbsolute(inputPath) ? inputPath : inputPath);
  const rel = candidate.slice(canonicalRepo.length);
  // Block escape via .. traversal
  if (
    candidate !== canonicalRepo &&
    !candidate.startsWith(`${canonicalRepo}/`) &&
    !candidate.startsWith(`${canonicalRepo}\\`)
  ) {
    throw new Error("LSP file must be contained inside the active repository.");
  }
  if (!existsSync(candidate)) {
    throw new Error(`LSP target file does not exist: ${inputPath}`);
  }
  if (!statSync(candidate).isFile()) {
    throw new Error("LSP target must be a regular file.");
  }
  if (statSync(candidate).size > DEFAULT_MAX_FILE_BYTES) {
    throw new Error(`LSP file exceeds the ${DEFAULT_MAX_FILE_BYTES}-byte size cap.`);
  }
  return candidate;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createLspTool(options: LspToolOptions = {}): ToolDefinition<
  typeof LspToolInputSchema,
  typeof LspToolOutputSchema
> {
  const adapter = options.adapter ?? createTypeScriptLanguageServerAdapter(options.adapterOptions);

  return {
    id: "lsp",
    title: "LSP code intelligence",
    description:
      "Read-only TypeScript language-server intelligence: status, diagnostics, definition, references, and hover. Requires a local or PATH typescript-language-server.",
    inputSchema: LspToolInputSchema,
    outputSchema: LspToolOutputSchema,
    async execute(input, _context) {
      const repoRoot = resolve(input.repoRoot);

      if (input.action === "status") {
        try {
          const available = await adapter.status(repoRoot);
          if (available) {
            return {
              status: "available",
              summary: "typescript-language-server is available."
            };
          }
          return {
            status: "unavailable",
            summary:
              "typescript-language-server is unavailable. Install it in the project (npm install typescript-language-server) or place it on PATH."
          };
        } catch (error) {
          return {
            status: "unavailable",
            summary: `typescript-language-server probe failed: ${formatError(error)}`
          };
        }
      }

      // All non-status actions require a validated path.
      try {
        const safePath = resolveSafePath(repoRoot, input.path!);

        switch (input.action) {
          case "diagnostics": {
            const diags = await adapter.diagnostics({
              repoRoot,
              filePath: safePath
            });
            return {
              status: "completed",
              summary: `${diags.length} diagnostic(s).`,
              diagnostics: diags as LspDiagnostic[]
            };
          }

          case "definition": {
            const locs = await adapter.definition({
              repoRoot,
              filePath: safePath,
              line: input.line!,
              character: input.character!
            });
            if (locs.length === 0) {
              return {
                status: "completed",
                summary: "No definition found.",
                locations: []
              };
            }
            return {
              status: "completed",
              summary: `${locs.length} definition location(s).`,
              locations: locs as LspLocation[]
            };
          }

          case "references": {
            const locs = await adapter.references({
              repoRoot,
              filePath: safePath,
              line: input.line!,
              character: input.character!
            });
            if (locs.length === 0) {
              return {
                status: "completed",
                summary: "No references found.",
                locations: []
              };
            }
            return {
              status: "completed",
              summary: `${locs.length} reference(s).`,
              locations: locs as LspLocation[]
            };
          }

          case "hover": {
            const text = await adapter.hover({
              repoRoot,
              filePath: safePath,
              line: input.line!,
              character: input.character!
            });
            if (text === null) {
              return {
                status: "completed",
                summary: "No hover information at this position.",
                hover: ""
              };
            }
            return {
              status: "completed",
              summary: "Hover information returned.",
              hover: text
            };
          }

          default:
            return {
              status: "failed",
              summary: `Unknown LSP action: ${(input as { action: string }).action}`
            };
        }
      } catch (error) {
        return {
          status: "failed",
          summary: formatError(error)
        };
      }
    }
  };
}
