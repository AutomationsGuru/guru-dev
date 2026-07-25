import { z } from "zod";

/**
 * Named mode manifest (IDEA-F368-MODE-01) — the builtin registry of agent modes.
 *
 * Each mode maps a stable id to a tool allowlist and an optional system-prompt
 * addendum. Unknown modes fail closed: resolveMode throws rather than defaulting.
 *
 * The catalog is a pure lookup structure — no side effects, no file I/O.
 * Project mode definitions (F85) merge over this builtin set without expanding
 * past hard-limit tools.
 */

export const NamedModeEntrySchema = z
  .object({
    /** Stable mode id — "code", "plan", "ask", "review", "debug". */
    id: z.string().trim().min(1),
    /** Human-readable label shown in the mode switcher. */
    description: z.string().trim().min(1).optional(),
    /** Tools available while this mode is active. Must include at least one tool. */
    toolAllowlist: z.array(z.string().trim().min(1)).min(1),
    /** Appended to the system prompt while this mode is active. */
    systemAddendum: z.string().optional()
  })
  .strict();

export type NamedModeEntry = z.infer<typeof NamedModeEntrySchema>;

/** An immutable catalog of named mode entries keyed by id. */
export type NamedModeCatalog = readonly NamedModeEntry[];

/**
 * Builtin named modes — the default catalog.
 *
 * Project modes (F85) merge on top without removing these entries or relaxing
 * hard limits. The five modes mirror the stage-appropriate autonomy pattern:
 * code (full), plan (design-only), ask (reference), review (adversarial),
 * debug (diagnose).
 */
export const BUILTIN_NAMED_MODES: NamedModeCatalog = NamedModeEntrySchema.array().parse([
  {
    id: "code",
    description: "Full implementation — read, write, edit, and execute tools available",
    toolAllowlist: ["read", "write", "edit", "bash"],
    systemAddendum:
      "You are in CODE mode. Implement changes, write tests, verify, and iterate. Prefer the smallest correct change."
  },
  {
    id: "plan",
    description: "Design and planning — read-only analysis with structured output",
    toolAllowlist: ["read"],
    systemAddendum:
      "You are in PLAN mode. Analyze the codebase, design an approach, and produce a concrete plan. Do not make any changes."
  },
  {
    id: "ask",
    description: "Question answering — read-only reference with no mutations",
    toolAllowlist: ["read"],
    systemAddendum:
      "You are in ASK mode. Answer questions using the available context. Do not make any changes."
  },
  {
    id: "review",
    description: "Code review — read-only adversarial analysis",
    toolAllowlist: ["read"],
    systemAddendum:
      "You are in REVIEW mode. Review code for correctness, security, contracts, and simplicity. Report findings only. Do not make changes."
  },
  {
    id: "debug",
    description: "Debugging — diagnostic tools available, no persistent mutations",
    toolAllowlist: ["read", "bash"],
    systemAddendum:
      "You are in DEBUG mode. Diagnose issues using available tools. Propose fixes with evidence. Do not apply fixes."
  }
]);

/**
 * Resolve a mode id against a catalog.
 *
 * Returns the matching {@link NamedModeEntry} when the id is found.
 * Throws when the id is unknown — fail-closed by design; unknown modes
 * must not silently degrade to a permissive default.
 *
 * @param id - The mode id to resolve (e.g. "code", "plan").
 * @param catalog - The catalog to search (defaults to {@link BUILTIN_NAMED_MODES}).
 * @returns The resolved named mode entry.
 * @throws {Error} When the id is not found in the catalog.
 */
export function resolveMode(id: string, catalog: NamedModeCatalog = BUILTIN_NAMED_MODES): NamedModeEntry {
  const entry = catalog.find((e) => e.id === id);
  if (!entry) {
    const available = catalog.map((e) => e.id).join(", ");
    throw new Error(`Unknown named mode: "${id}". Available modes: ${available}`);
  }
  return entry;
}
