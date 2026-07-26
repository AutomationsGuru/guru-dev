import { z } from "zod";

import type { ToolDefinition } from "../registry.js";
import {
  proposeAllowlistFromDenials,
  type AllowlistProposalArtifact,
  type ToolDenialRecord
} from "../../mandates/allowlistPropose.js";

/**
 * `allowlist.propose` — an OPTIONAL, read-only tool (IDEA-F13 / R-CC-ALLOW).
 *
 * It scans recent session tool denials (supplied by the host runtime) and
 * emits a proposal artifact for OPERATOR review. It never applies a grant,
 * never mutates mandate state, and hard-limit classes are permanently
 * excluded inside {@link proposeAllowlistFromDenials} — not by prompt text.
 *
 * The tool ships with NO default backend: a runtime that does not wire
 * `onPropose` gets an explicit "not supported" error rather than a silent
 * no-op, matching the monitor/manageTask seam.
 */

const MandateVerbEnum = z.enum(["read", "write", "exec", "net", "spend", "destructive", "secret-edge", "auth-edge"]);

export const ProposeAllowlistToolInputSchema = z
  .object({
    MaxDenials: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Maximum recent denials to scan. Defaults to the backend's own bound (never more than 500).")
  })
  .strict();

const ProposalSchema = z
  .object({
    toolId: z.string(),
    verbs: z.array(MandateVerbEnum),
    occurrences: z.number().int().positive(),
    sampleInputSummary: z.string()
  })
  .strict();

const ExcludedSchema = z
  .object({
    toolId: z.string(),
    verbs: z.array(MandateVerbEnum),
    exclusion: z.enum(["hard-edge", "read-only"])
  })
  .strict();

export const ProposeAllowlistToolOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    scanned: z.number().int().nonnegative(),
    proposals: z.array(ProposalSchema),
    excluded: z.array(ExcludedSchema)
  })
  .strict();

export type ProposeAllowlistToolOutput = z.infer<typeof ProposeAllowlistToolOutputSchema>;

export interface ProposeAllowlistToolOptions {
  /**
   * Host-supplied denial feed: returns the most recent tool denials (newest
   * first is fine — ordering does not affect the artifact). The host owns
   * where denials come from (transcript, event log, in-memory gate records).
   */
  readonly onPropose?: (maxDenials: number) => Promise<readonly ToolDenialRecord[]> | readonly ToolDenialRecord[];
}

export function createProposeAllowlistTool(
  options: ProposeAllowlistToolOptions = {}
): ToolDefinition<typeof ProposeAllowlistToolInputSchema, typeof ProposeAllowlistToolOutputSchema> {
  return {
    id: "allowlist.propose",
    title: "Propose Allowlist Grants",
    description:
      "Scan recent tool denials and propose non-hard-edge allowlist grants for operator approval. " +
      "Proposals are advisory only — nothing is applied, and hard-limit classes are permanently excluded.",
    inputSchema: ProposeAllowlistToolInputSchema,
    outputSchema: ProposeAllowlistToolOutputSchema,
    effect: "read-only",
    async execute(input): Promise<AllowlistProposalArtifact> {
      if (!options.onPropose) {
        throw new Error("allowlist.propose is not supported in this runtime environment (no denial feed backend).");
      }
      const denials = await options.onPropose(input.MaxDenials ?? 100);
      return proposeAllowlistFromDenials(denials);
    }
  };
}
