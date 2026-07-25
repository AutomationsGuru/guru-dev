import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  resolveOracleRoute,
  OracleRouteConfigSchema,
  OracleRolePackSchema,
  type OracleRoute,
  type OracleRolePack
} from "../../routing/oracleRoute.js";
import type { ToolDefinition } from "../registry.js";

/**
 * Oracle second-opinion tool (F86): ask a DISTINCT high-reasoning route about a
 * question or diff and get analysis back. Consult is not a gate — it returns
 * analysis only, never auto-applies, never blocks. Read-only BY CONSTRUCTION:
 * the tool holds no write capability (no fs handle, no executor); the injected
 * `consultModel` is a single-turn text-in/text-out call with no tools, same
 * posture as the native critic panel. Missing or non-distinct routes fail
 * closed: no call is made and the output says why.
 */

/** Hard cap on context folded into the oracle prompt (bounds cost + tokens). */
const MAX_CONTEXT_CHARS = 120_000;
/** Per-file cap so one huge file cannot consume the whole context budget. */
const MAX_FILE_CHARS = 40_000;

export const OracleConsultInputSchema = z
  .object({
    /** The question or decision the oracle should analyze. */
    question: z.string().trim().min(1),
    /** Optional repo-relative context paths (read-only; missing paths are reported, not fatal). */
    paths: z.array(z.string().trim().min(1)).default([]),
    /** Optional inline diff/patch text to analyze instead of (or alongside) paths. */
    diff: z.string().optional()
  })
  .strict();
export type OracleConsultInput = z.infer<typeof OracleConsultInputSchema>;

export const OracleConsultOutputSchema = z
  .object({
    /** True only when a distinct oracle route was actually consulted. */
    consulted: z.boolean(),
    /** The oracle's analysis text (empty when not consulted). */
    analysis: z.string(),
    /** Route resolution details for auditability. */
    route: z
      .object({
        model: z.string(),
        source: z.enum(["role-pack", "config"]),
        distinctFromAuthor: z.boolean()
      })
      .optional(),
    /** Context paths that did not resolve (reported, not fatal). */
    missingPaths: z.array(z.string()).default([]),
    summary: z.string()
  })
  .strict();
export type OracleConsultOutput = z.infer<typeof OracleConsultOutputSchema>;

/**
 * The one external dependency — a single-turn model call on the oracle route.
 * Same read-only-by-construction posture as the native critic panel's AskModel:
 * the oracle receives a prompt and returns text; it is never handed a tool.
 */
export type OracleConsultModel = (prompt: string, meta: { readonly model: string }) => Promise<string>;

export interface OracleConsultToolOptions {
  readonly config: z.input<typeof OracleRouteConfigSchema>;
  /** The model that produced the work under question (the "author"). */
  readonly authorModel?: string;
  /** F3 model role pack, when that feature is present. */
  readonly rolePack?: OracleRolePack;
  /**
   * Single-turn call on the oracle route. Required for a real consult; without
   * it the tool still resolves the route and reports it, but cannot consult.
   */
  readonly consultModel?: OracleConsultModel;
}

function buildPrompt(input: OracleConsultInput, contextBlocks: readonly string[]): string {
  const sections = [
    "You are an oracle: a distinct, high-reasoning second opinion. Analyze the question below and return analysis ONLY — do not propose to apply changes, do not write files, do not run commands.",
    "Be direct: state your position, the strongest evidence for and against, and any risks the author may have missed.",
    "",
    `QUESTION: ${input.question}`
  ];
  if (input.diff) {
    sections.push("", "----- DIFF UNDER QUESTION -----", input.diff.slice(0, MAX_CONTEXT_CHARS), "----- END DIFF -----");
  }
  if (contextBlocks.length > 0) {
    sections.push("", ...contextBlocks);
  }
  return sections.join("\n").slice(0, MAX_CONTEXT_CHARS + 4_000);
}

export function createOracleConsultTool(
  options: OracleConsultToolOptions
): ToolDefinition<typeof OracleConsultInputSchema, typeof OracleConsultOutputSchema> {
  const config = OracleRouteConfigSchema.parse(options.config);
  const rolePack = options.rolePack ? OracleRolePackSchema.parse(options.rolePack) : undefined;

  return {
    id: "oracle_consult",
    title: "Oracle second opinion",
    description:
      "Consult a distinct high-reasoning model route about a question or diff and get analysis back. Analysis only — never applies changes, never blocks. Fails closed when no distinct oracle route is configured. Read-only.",
    inputSchema: OracleConsultInputSchema,
    outputSchema: OracleConsultOutputSchema,
    effect: "read-only",
    async execute(rawInput, context) {
      const input = OracleConsultInputSchema.parse(rawInput);
      const resolution = resolveOracleRoute({
        config,
        ...(options.authorModel !== undefined ? { authorModel: options.authorModel } : {}),
        ...(rolePack !== undefined ? { rolePack } : {})
      });

      if (resolution.status !== "resolved" || !resolution.route) {
        return {
          consulted: false,
          analysis: "",
          missingPaths: [],
          summary: `Oracle consult skipped — ${resolution.reason}`
        };
      }
      const route: OracleRoute = resolution.route;

      if (!options.consultModel) {
        return {
          consulted: false,
          analysis: "",
          route: { model: route.model, source: route.source, distinctFromAuthor: route.distinctFromAuthor },
          missingPaths: [],
          summary: `Oracle route "${route.model}" resolved (${route.source}) but no consult channel is wired — failing closed rather than guessing.`
        };
      }

      // Fold optional context paths into the prompt (read-only; bounded).
      const cwd = context.cwd ? resolve(context.cwd) : process.cwd();
      const contextBlocks: string[] = [];
      const missingPaths: string[] = [];
      let contextChars = 0;
      for (const path of input.paths) {
        try {
          const text = await readFile(resolve(cwd, path), "utf8");
          const clipped = text.slice(0, Math.min(MAX_FILE_CHARS, MAX_CONTEXT_CHARS - contextChars));
          contextChars += clipped.length;
          contextBlocks.push(`----- CONTEXT: ${path} -----\n${clipped}\n----- END CONTEXT: ${path} -----`);
        } catch {
          missingPaths.push(path);
        }
        if (contextChars >= MAX_CONTEXT_CHARS) {
          break;
        }
      }

      try {
        const analysis = await options.consultModel(buildPrompt(input, contextBlocks), { model: route.model });
        return {
          consulted: true,
          analysis,
          route: { model: route.model, source: route.source, distinctFromAuthor: route.distinctFromAuthor },
          missingPaths,
          summary: `Oracle "${route.model}" (${route.source}) consulted — analysis only, nothing applied.${missingPaths.length > 0 ? ` ${missingPaths.length} context path(s) missing.` : ""}`
        };
      } catch (error) {
        return {
          consulted: false,
          analysis: "",
          route: { model: route.model, source: route.source, distinctFromAuthor: route.distinctFromAuthor },
          missingPaths,
          summary: `Oracle consult failed on route "${route.model}": ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
  };
}
