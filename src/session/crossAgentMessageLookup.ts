import { z } from "zod";

import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * Cross-agent message lookup (IDEA-F195-XAGENT-LOOKUP-01) — lets one agent
 * query another agent's message index when policy allows. Pure ACL check +
 * in-memory search: no persistence, no provider calls, no framework.
 *
 * Design:
 * - The ACL (`CrossAgentLookupPolicy`) is a typed zod contract, enforced in
 *   code — not prose (§5.13). Wildcard `*` allows every peer; an explicit
 *   allowlist gates lookups per requesting agent.
 * - Secret values NEVER cross an agent boundary (Constitution §3.3): every
 *   hit is scrubbed through the structural scrubber before it is returned.
 * - Results are bounded (hard-capped in the schema, swarm-style) so a lookup
 *   cannot dump an unbounded transcript.
 */

/** The policy that decides whether agent `from` may search agent `to`'s index. */
export const CrossAgentLookupPolicySchema = z
  .object({
    /** Allowlist per requesting agent id. `"*"` allows lookups by any agent. */
    allow: z.record(z.string(), z.array(z.string().min(1)).min(1))
  })
  .strict();
export type CrossAgentLookupPolicy = z.infer<typeof CrossAgentLookupPolicySchema>;

/** One indexed message from an agent's history. */
export const IndexedMessageSchema = z
  .object({
    role: z.string().min(1),
    content: z.string()
  })
  .strict();
export type IndexedMessage = z.infer<typeof IndexedMessageSchema>;

/** Options for a lookup. */
export const CrossAgentLookupOptionsSchema = z
  .object({
    /** Case-insensitive substring search over the message index. */
    query: z.string().min(1),
    /** Maximum hits returned. Hard-capped so a lookup is always bounded. */
    limit: z.number().int().positive().max(50).default(10)
  })
  .strict();
export type CrossAgentLookupOptions = z.input<typeof CrossAgentLookupOptionsSchema>;

/** A single lookup hit. Content is always secret-scrubbed before it leaves. */
export interface CrossAgentLookupHit {
  readonly agentId: string;
  readonly index: number;
  readonly role: string;
  readonly content: string;
}

/**
 * Pure ACL check: may agent `from` look up messages in agent `to`'s index
 * under `policy`? An agent may always look up its OWN index — no self-lookup
 * grant is required. Policy must be schema-parsed before it reaches here.
 */
export function canLookup(from: string, to: string, policy: CrossAgentLookupPolicy): boolean {
  if (from === to) {
    return true;
  }
  const allowed = policy.allow[to];
  return allowed !== undefined && (allowed.includes("*") || allowed.includes(from));
}

/**
 * Search `to`'s message index on behalf of `from`. Returns `null` when the
 * policy denies the lookup (deny is silent — the requesting agent learns only
 * that the lookup was not allowed, never the index contents). On allow, hits
 * are the case-insensitive query matches in index order, capped at `limit`,
 * each content scrubbed by the structural secret scrubber before crossing the
 * agent boundary.
 */
export function lookup(
  from: string,
  to: string,
  index: readonly IndexedMessage[],
  options: CrossAgentLookupOptions,
  policy: CrossAgentLookupPolicy
): readonly CrossAgentLookupHit[] | null {
  if (!canLookup(from, to, policy)) {
    return null;
  }
  const { query, limit } = CrossAgentLookupOptionsSchema.parse(options);
  const needle = query.toLowerCase();
  const hits: CrossAgentLookupHit[] = [];
  for (let i = 0; i < index.length && hits.length < limit; i += 1) {
    const message = index[i];
    if (message && message.content.toLowerCase().includes(needle)) {
      hits.push({
        agentId: to,
        index: i,
        role: message.role,
        content: scrubSecretValues(message.content)
      });
    }
  }
  return hits;
}
