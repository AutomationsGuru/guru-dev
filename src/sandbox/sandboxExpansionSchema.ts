import { z } from "zod";

/**
 * F97 Sandbox Expansion — Zod schemas.
 *
 * A sandboxed tool that fails for missing path/network rights (or is classified
 * as needing extra mounts) produces an {@link ExpansionNeed}. The operator issues
 * an {@link ExpansionDecision}: approve grants a ONE-SHOT expansion (one tool
 * call, consumed immediately after), deny keeps the original sandbox.
 *
 * Hard limits from the constitution (§3) are enforced structurally before any
 * expansion is applied — expand never silently lifts a destructive, spend,
 * secret-edge, or auth-edge path.
 */

/** A structured signal that a tool call needs broader sandbox access. */
export const ExpansionNeedSchema = z
  .object({
    /** Absolute or workspace-relative paths the tool needs access to. */
    paths: z.array(z.string().min(1)).default([]),
    /** Whether the tool needs network access beyond the baseline. */
    network: z.boolean().default(false),
    /** Human-readable reason for the expansion request (surfaced to the operator). */
    reason: z.string().min(1)
  })
  .strict();

export type ExpansionNeed = z.infer<typeof ExpansionNeedSchema>;

/** Operator response to an expansion request. */
export const ExpansionDecisionSchema = z.enum(["approve", "deny"]);
export type ExpansionDecision = z.infer<typeof ExpansionDecisionSchema>;

/**
 * A one-shot expansion scope produced by an approved expansion. The consumer
 * (tool executor) checks the expanded paths and network flag, re-runs the
 * single tool call, then calls `consume()` to invalidate the expansion.
 * A second `consume()` throws — this is one-shot by construction.
 */
export const OneShotExpansionSchema = z
  .object({
    /** Paths granted for this single call. */
    expandedPaths: z.instanceof(Set).describe("ReadonlySet<string>"),
    /** Whether network access is granted for this single call. */
    networkAllowed: z.boolean(),
    /** Whether the expansion has been consumed. */
    consumed: z.boolean()
  })
  .strict();

/**
 * A lightweight expansion session — the container that holds the current
 * operator-approved expansion (if any). The tool executor drains it on the
 * next eligible tool call.
 */
export const ExpansionSessionSchema = z
  .object({
    /** The active one-shot expansion, or null when no expansion is pending. */
    activeExpansion: OneShotExpansionSchema.nullable().default(null)
  })
  .strict();