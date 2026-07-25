import { z } from "zod";

import {
  ArchitectEditorResultSchema,
  ArchitectProposalSchema,
  EditorEditListSchema,
  type ArchitectEditorResult,
  type ArchitectProposal
} from "./architectEditorSchema.js";

export type { ArchitectEditorResult, ArchitectProposal };
export { ArchitectEditorResultSchema, ArchitectProposalSchema, EditorEditListSchema } from "./architectEditorSchema.js";

export interface ArchitectModelRequest {
  readonly objective: string;
  readonly context?: unknown;
}

export interface EditorModelRequest {
  readonly objective: string;
  readonly proposal: ArchitectProposal;
  readonly context?: unknown;
}

export interface ArchitectModel {
  createProposal(request: ArchitectModelRequest): Promise<unknown> | unknown;
}

export interface EditorModel {
  createEdits(request: EditorModelRequest): Promise<unknown> | unknown;
}

export interface ArchitectEditorPipelineOptions {
  /** Pipeline objective / user request. */
  readonly objective: string;
  /**
   * Explicit opt-in. When false (default) the pipeline returns immediately
   * without invoking either model, so disabled sessions remain single-pass.
   */
  readonly architectEditor: boolean;
  /** Architect model: produces a natural-language change proposal. */
  readonly architect: ArchitectModel;
  /** Editor model: turns a validated proposal into structured edit ops. */
  readonly editor: EditorModel;
  /** Optional context passed to both models. */
  readonly context?: unknown;
  /**
   * When true, downstream code must route the returned ops through the normal
   * mandate/approval gates instead of auto-applying. The pipeline itself never
   * applies edits; this flag is surfaced for transparency.
   */
  readonly sandboxPending?: boolean;
}

/**
 * Run the optional architect → editor two-phase pipeline.
 *
 * Bound: when enabled, exactly one architect call and one editor call are made.
 * When disabled, zero model calls are made. The pipeline never mutates files;
 * it returns validated edit ops for the caller to apply (or not) through gates.
 */
export async function runArchitectEditorPipeline(
  options: ArchitectEditorPipelineOptions
): Promise<ArchitectEditorResult> {
  if (!options.architectEditor) {
    return ArchitectEditorResultSchema.parse({
      enabled: false,
      proposal: null,
      edits: []
    });
  }

  let proposal: ArchitectProposal | null = null;

  try {
    const rawProposal = await options.architect.createProposal({
      objective: options.objective,
      context: options.context
    });
    const proposalResult = ArchitectProposalSchema.safeParse(rawProposal);

    if (!proposalResult.success) {
      return ArchitectEditorResultSchema.parse({
        enabled: true,
        proposal: null,
        edits: [],
        failureReason: "invalid-proposal",
        error: `Architect proposal is invalid: ${formatIssues(proposalResult.error.issues)}`
      });
    }

    proposal = proposalResult.data;
  } catch (error) {
    return ArchitectEditorResultSchema.parse({
      enabled: true,
      proposal: null,
      edits: [],
      failureReason: "architect-threw",
      error: `Architect model failed: ${formatError(error)}`
    });
  }

  try {
    const rawEdits = await options.editor.createEdits({
      objective: options.objective,
      proposal,
      context: options.context
    });
    const editsResult = EditorEditListSchema.safeParse(rawEdits);

    if (!editsResult.success) {
      return ArchitectEditorResultSchema.parse({
        enabled: true,
        proposal,
        edits: [],
        failureReason: "invalid-edits",
        error: `Editor edit list is invalid: ${formatIssues(editsResult.error.issues)}`
      });
    }

    return ArchitectEditorResultSchema.parse({
      enabled: true,
      proposal,
      edits: editsResult.data.edits
    });
  } catch (error) {
    return ArchitectEditorResultSchema.parse({
      enabled: true,
      proposal,
      edits: [],
      failureReason: "editor-threw",
      error: `Editor model failed: ${formatError(error)}`
    });
  }
}

function formatIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";

      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
