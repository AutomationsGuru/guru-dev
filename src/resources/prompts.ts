/**
 * Prompt template + snippet resource schemas (Dev 4 — interface freeze skeleton, D4.5 impl).
 *
 * FR-13 (prompt template, package, and theme parity): prompt templates with
 * variables/arguments AND prompt snippets/guidelines for tools. Schemas + loader
 * contract only; the file-walking loader lands in D4.5. Secret-safe: variables carry
 * names + defaults only; bodies are templates and must never hold credential material
 * (load-time secret scan is a D4.5/D4.6 responsibility — see TODO below).
 */

import { z } from "zod";

import { ResourceScopeSchema } from "./scope.js";
import type { ResourceScope } from "./scope.js";

export const PromptTrustSchema = z.enum(["trusted", "untrusted"]);
export type PromptTrust = z.infer<typeof PromptTrustSchema>;

export const PromptTemplateVariableSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().min(1).max(400).optional(),
    required: z.boolean().default(false),
    /** Literal default value for the variable (template text, never a secret). */
    default: z.string().max(2000).optional()
  })
  .strict();
export type PromptTemplateVariable = z.infer<typeof PromptTemplateVariableSchema>;

export const PromptTemplateSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1000).optional(),
    variables: z.array(PromptTemplateVariableSchema).default([]),
    /** Template body, may reference {{variable}} placeholders. */
    body: z.string().min(1).max(50000),
    trust: PromptTrustSchema.default("untrusted"),
    scope: ResourceScopeSchema.default("project"),
    /** Originating file path (provenance; not a secret). */
    sourcePath: z.string().trim().min(1).max(1024).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).default([])
  })
  .strict();
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

/**
 * Short tool prompt snippet / per-tool usage guideline (FR-13 line 376).
 * e.g. the guideline a reference harness attaches to `mcp_call_tool` / `provider_cli_run`.
 */
export const PromptSnippetSchema = z
  .object({
    id: z.string().trim().min(1),
    /** Tool id this guideline applies to, or undefined for a general snippet. */
    toolId: z.string().trim().min(1).max(120).optional(),
    trigger: z.string().trim().min(1).max(200).optional(),
    body: z.string().min(1).max(20000),
    trust: PromptTrustSchema.default("untrusted"),
    scope: ResourceScopeSchema.default("project")
  })
  .strict();
export type PromptSnippet = z.infer<typeof PromptSnippetSchema>;

export const PromptRegistrySchema = z
  .object({
    templates: z.array(PromptTemplateSchema).default([]),
    snippets: z.array(PromptSnippetSchema).default([])
  })
  .strict();
export type PromptRegistry = z.infer<typeof PromptRegistrySchema>;
export type { ResourceScope as PromptScope };

/**
 * Loader contract (impl in D4.5). Reads prompt roots, parses frontmatter/body,
 * and returns validated templates + snippets.
 * TODO(D4.5/D4.6): scan template/snippet bodies for secret material at load time,
 * not only at restore-package generation.
 */
export interface PromptLoader {
  readonly roots: readonly string[];
  list(): Promise<PromptTemplate[]>;
  get(id: string): Promise<PromptTemplate | undefined>;
  listSnippets(): Promise<PromptSnippet[]>;
  getSnippet(id: string): Promise<PromptSnippet | undefined>;
}
