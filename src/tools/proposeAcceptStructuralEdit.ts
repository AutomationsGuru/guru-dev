import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { guardContent, guardWritePath, type ToolPolicy } from "../safety/policyGuard.js";
import type { ToolDefinition } from "./registry.js";

/**
 * Propose-accept structural edit (IDEA-F438 / R-OMP-PROPOSE).
 *
 * A propose-then-accept file edit: `propose` stages an exact-text edit in memory
 * (no disk mutation) and returns a redacted preview + proposalId; `accept`
 * applies exactly one staged edit to disk after re-verifying the target has not
 * drifted; `reject` discards a staged edit without applying it. Nothing is
 * written until `accept`, and a proposal can be applied at most once.
 *
 * Lifecycle mirrors the codebase's decision vocabulary (`proposed / accepted /
 * rejected`, see operational/schemas) and the exact-edit uniqueness rules (see
 * builtins/exactEditTool). Policy guards (risky paths, secret-bearing content)
 * run at propose time so a blocked proposal is never staged; previews are
 * byte-redacted so proposed content is never echoed back in the clear.
 */

const ProposeActionInputSchema = z
  .object({
    action: z.literal("propose"),
    repoRoot: z.string().trim().min(1),
    path: z.string().trim().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().default(false)
  })
  .strict();

const AcceptActionInputSchema = z
  .object({
    action: z.literal("accept"),
    proposalId: z.string().trim().min(1)
  })
  .strict();

const RejectActionInputSchema = z
  .object({
    action: z.literal("reject"),
    proposalId: z.string().trim().min(1)
  })
  .strict();

export const ProposeAcceptStructuralEditInputSchema = z.discriminatedUnion("action", [
  ProposeActionInputSchema,
  AcceptActionInputSchema,
  RejectActionInputSchema
]);

export const ProposeAcceptStructuralEditOutputSchema = z
  .object({
    action: z.enum(["propose", "accept", "reject"]),
    // propose: was the edit staged? accept/reject: did the lifecycle act on a real proposal?
    staged: z.boolean().optional(),
    applied: z.boolean(),
    discarded: z.boolean().optional(),
    proposalId: z.string().optional(),
    path: z.string().optional(),
    replacements: z.number().int().nonnegative().optional(),
    previewDiff: z.string().optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export type ProposeAcceptStructuralEditInput = z.infer<
  typeof ProposeAcceptStructuralEditInputSchema
>;
export type ProposeAcceptStructuralEditOutput = z.infer<
  typeof ProposeAcceptStructuralEditOutputSchema
>;

export interface ProposeAcceptStructuralEditOptions {
  readonly riskyPathPatterns: readonly string[];
  readonly secretAllowList: readonly string[];
  readonly allowRiskyPaths?: boolean;
}

interface PendingProposal {
  readonly repoRoot: string;
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll: boolean;
}

function newProposalId(): string {
  // Short, opaque, unguessable-enough id for an in-process proposal handle.
  return `pae_${randomBytes(6).toString("base64url")}`;
}

export function createProposeAcceptStructuralEditTool(
  options: ProposeAcceptStructuralEditOptions = { riskyPathPatterns: [], secretAllowList: [] }
): ToolDefinition<typeof ProposeAcceptStructuralEditInputSchema, typeof ProposeAcceptStructuralEditOutputSchema> {
  // In-process staging store. Owned by this factory closure (mirrors how other
  // tool factories hold state via closure options). A proposal lives only until
  // it is accepted or rejected.
  const pending = new Map<string, PendingProposal>();

  return {
    id: "edit.proposeAccept",
    title: "Propose-accept structural edit",
    description:
      "Stage a proposed exact-text edit, then apply it only on explicit accept (discard on reject). " +
      "PRESERVE, DON'T REPLACE: prefer edits that improve, enhance, clarify, or expand. " +
      "Before accepting a block removal, confirm it really must go (yes/no) and cannot be enriched instead.",
    inputSchema: ProposeAcceptStructuralEditInputSchema,
    outputSchema: ProposeAcceptStructuralEditOutputSchema,
    async execute(input) {
      switch (input.action) {
        case "propose":
          return propose(input, pending, options);
        case "accept":
          return accept(input, pending);
        case "reject":
          return reject(input, pending);
      }
    }
  };
}

async function propose(
  input: Extract<ProposeAcceptStructuralEditInput, { action: "propose" }>,
  pending: Map<string, PendingProposal>,
  options: ProposeAcceptStructuralEditOptions
): Promise<ProposeAcceptStructuralEditOutput> {
  const repoRoot = resolve(input.repoRoot);
  const targetPath = resolve(repoRoot, input.path);
  const rel = relative(repoRoot, targetPath) || input.path;
  const policy: ToolPolicy = {
    repoRoot,
    riskyPathPatterns: options.riskyPathPatterns,
    secretAllowList: options.secretAllowList,
    allowRiskyPaths: Boolean(options.allowRiskyPaths)
  };

  const blockers = [
    ...guardWritePath(input.path, policy).blockers,
    ...guardContent(
      [
        { name: "oldText", value: input.oldText },
        { name: "newText", value: input.newText }
      ],
      policy
    ).blockers
  ];

  if (!existsSync(targetPath)) {
    blockers.push("Target file does not exist.");
  }

  if (blockers.length > 0) {
    return {
      action: "propose",
      staged: false,
      applied: false,
      blockers,
      summary: `Proposal blocked by ${blockers.length} policy check(s).`
    };
  }

  const before = await readFile(targetPath, "utf8");
  const occurrences = countOccurrences(before, input.oldText);
  if (occurrences === 0) {
    return {
      action: "propose",
      staged: false,
      applied: false,
      blockers: ["oldText was not found in the target file."],
      summary: "Proposal blocked because oldText was not found."
    };
  }
  if (!input.replaceAll && occurrences !== 1) {
    return {
      action: "propose",
      staged: false,
      applied: false,
      blockers: [
        `oldText matched ${occurrences} times; exact edit requires a unique match unless replaceAll=true.`
      ],
      summary: "Proposal blocked by uniqueness validation."
    };
  }

  const proposalId = newProposalId();
  pending.set(proposalId, {
    repoRoot,
    path: rel,
    oldText: input.oldText,
    newText: input.newText,
    replaceAll: input.replaceAll
  });

  const replacements = input.replaceAll ? occurrences : 1;
  const afterBytes = Buffer.byteLength(input.newText, "utf8");

  return {
    action: "propose",
    staged: true,
    applied: false,
    proposalId,
    path: rel,
    replacements,
    previewDiff: buildPreviewDiff(rel, afterBytes),
    blockers: [],
    summary: `Staged proposal ${proposalId} (${replacements} replacement(s)) for ${rel}. Not yet applied.`
  };
}

async function accept(
  input: Extract<ProposeAcceptStructuralEditInput, { action: "accept" }>,
  pending: Map<string, PendingProposal>
): Promise<ProposeAcceptStructuralEditOutput> {
  const proposal = pending.get(input.proposalId);
  if (!proposal) {
    return {
      action: "accept",
      applied: false,
      blockers: [`No staged proposal with id ${input.proposalId}.`],
      summary: "Accept had no matching staged proposal; nothing was applied."
    };
  }

  const targetPath = resolve(proposal.repoRoot, proposal.path);
  if (!existsSync(targetPath)) {
    pending.delete(input.proposalId);
    return {
      action: "accept",
      applied: false,
      path: proposal.path,
      blockers: ["Target file no longer exists."],
      summary: "Accept blocked because the target file disappeared."
    };
  }

  const before = await readFile(targetPath, "utf8");
  const occurrences = countOccurrences(before, proposal.oldText);
  if (occurrences === 0 || (!proposal.replaceAll && occurrences !== 1)) {
    // Drift: the file changed between propose and accept. Refuse to apply a
    // blind overwrite — preserve the operator's ability to re-propose against
    // the current contents. The proposal stays staged for a retry/reject.
    return {
      action: "accept",
      applied: false,
      path: proposal.path,
      blockers: [
        occurrences === 0
          ? "Target no longer matches oldText; the file has drifted since the proposal was staged."
          : `Target now matches oldText ${occurrences} times; the file has drifted since the proposal was staged.`
      ],
      summary: "Accept blocked because the staged proposal no longer matches the target."
    };
  }

  const after = proposal.replaceAll
    ? before.split(proposal.oldText).join(proposal.newText)
    : before.replace(proposal.oldText, proposal.newText);

  await writeFile(targetPath, after, "utf8");
  pending.delete(input.proposalId);

  const replacements = proposal.replaceAll ? occurrences : 1;
  return {
    action: "accept",
    applied: true,
    proposalId: input.proposalId,
    path: proposal.path,
    replacements,
    blockers: [],
    summary: `Applied proposal ${input.proposalId}: ${replacements} replacement(s) to ${proposal.path}.`
  };
}

function reject(
  input: Extract<ProposeAcceptStructuralEditInput, { action: "reject" }>,
  pending: Map<string, PendingProposal>
): ProposeAcceptStructuralEditOutput {
  const existed = pending.delete(input.proposalId);
  return {
    action: "reject",
    applied: false,
    discarded: existed,
    proposalId: input.proposalId,
    blockers: [],
    summary: existed
      ? `Discarded proposal ${input.proposalId}; nothing was applied.`
      : `No staged proposal with id ${input.proposalId}; nothing to discard.`
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function buildPreviewDiff(relativePath: string, afterBytes: number): string {
  // Byte-redacted preview (never echo proposed content; content was already
  // policy-checked at propose time). Mirrors fileEditTool's redaction posture.
  return [
    `--- ${relativePath}`,
    `+++ ${relativePath}`,
    `+ redacted proposed content (${afterBytes} byte(s))`
  ].join("\n");
}
