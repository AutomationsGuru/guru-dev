import { z } from "zod";

/**
 * Mandate model (Phase C, 2026-07-04) — standing permission grants that collapse
 * per-call approval prompts into policy. Grants are POLICY, not secrets, so they
 * persist at rest (~/.guruharness/mandates.json). Two axes stay distinct: what
 * tools EXIST (the suit) vs what a present tool MAY DO (the mandate, here).
 *
 * Design doc: planning/THERE.md §12; handoffs/guru-build-plan.md Phase C.
 */

/**
 * The verb a tool call exercises. `secret-edge` = a write/edit whose target is
 * secrets-adjacent (.env, *.pem, id_rsa, .npmrc auth, credentials); `auth-edge`
 * = a write to an ecosystem auth file (~/.aws/credentials, ~/.config/gh,
 * ~/.codex, provider token caches). Both are hard edges (see below).
 */
export const MandateVerbSchema = z.enum(["read", "write", "exec", "net", "spend", "destructive", "secret-edge", "auth-edge"]);
export type MandateVerb = z.infer<typeof MandateVerbSchema>;

/** Scope of a grant: a repo/dir subtree (SPACE) or the whole machine. */
export const MandateScopeSchema = z.enum(["space", "machine"]);
export type MandateScope = z.infer<typeof MandateScopeSchema>;

export const MandateGrantSchema = z
  .object({
    scope: MandateScopeSchema,
    /** For scope="space": the absolute directory subtree the grant covers. */
    path: z.string().min(1).optional(),
    verbs: z.array(MandateVerbSchema).min(1),
    grantedAt: z.string().min(1),
    note: z.string().min(1).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "space" && !value.path) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "space grants must carry a path.", path: ["path"] });
    }
  });

export type MandateGrant = z.infer<typeof MandateGrantSchema>;

/** A deny rule always beats a grant (deny-wins). Denies a verb, optionally within a path. */
export const MandateDenySchema = z
  .object({
    verb: MandateVerbSchema,
    path: z.string().min(1).optional(),
    note: z.string().min(1).optional()
  })
  .strict();

export type MandateDeny = z.infer<typeof MandateDenySchema>;

export const MandateStateSchema = z
  .object({
    grants: z.array(MandateGrantSchema).default([]),
    denies: z.array(MandateDenySchema).default([])
  })
  .strict();

export type MandateState = z.infer<typeof MandateStateSchema>;

/**
 * Verbs that are HARD EDGES: never covered by a standing grant, and — per THERE
 * v2 §2.3 (Article 3) — they must prompt in EVERY mode BELOW AND INCLUDING YOLO.
 * YOLO lifts ordinary permission gates but NOT these: destructive / spend /
 * secrets-adjacent-write / ecosystem-auth-file operations always escalate.
 */
export const HARD_EDGE_VERBS: ReadonlySet<MandateVerb> = new Set(["destructive", "spend", "secret-edge", "auth-edge"]);
