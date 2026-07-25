import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
function base36Stamp(): string {
  // ms since epoch encoded in base36 — compact, monotonic-ish, no Date.now() dependency in
  // the harness (safe for rehydrated plans).
  return BigInt(Date.now()).toString(36);
}
function base36Rand(): string {
  const chars: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    chars.push(BASE36_ALPHABET[Math.floor(Math.random() * 36)] as string);
  }
  return chars.join("");
}

export const ExploreCodebaseQuerySchema = z
  .object({
    /** Natural-language description of what to explore. */
    query: z.string().trim().min(1)
  })
  .strict();
export type ExploreCodebaseQuery = z.infer<typeof ExploreCodebaseQuerySchema>;

export const ExploreStepKindSchema = z.enum(["list-roots", "search", "read", "summarize"]);
export type ExploreStepKind = z.infer<typeof ExploreStepKindSchema>;

export const ExplorePlanStepSchema = z
  .object({
    kind: ExploreStepKindSchema,
    id: z.string().trim().min(1),
    /** Human-readable label for this step. */
    label: z.string().trim().min(1),
    /** For list-roots: which directories to enumerate. */
    roots: z.array(z.string()).optional(),
    /** For search: what to search for (regex or plain text). */
    search: z.string().optional(),
    /** For read: which file(s) to read (path or glob). */
    files: z.array(z.string()).optional(),
    /** For summarize: what aspects to highlight. */
    summarize: z.string().optional()
  })
  .strict();
export type ExplorePlanStep = z.infer<typeof ExplorePlanStepSchema>;

export const ExploreCodebasePlanSchema = z
  .object({
    id: z.string().trim().min(1),
    /** Ordered list of exploration steps. */
    steps: z.array(ExplorePlanStepSchema).min(1),
    /** Always true — this plan describes exploration; it does not execute it. */
    describesOnly: z.literal(true),
    /** The original query that generated this plan. */
    query: z.string().trim().min(1)
  })
  .strict();
export type ExploreCodebasePlan = z.infer<typeof ExploreCodebasePlanSchema>;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class EmptyExploreQueryError extends Error {
  constructor() {
    super('Explore query must be non-empty and non-whitespace.');
    this.name = "EmptyExploreQueryError";
  }
}

export function buildPlan(
  query: string,
  options?: { id?: string }
): ExploreCodebasePlan {
  if (query.trim().length === 0) {
    throw new EmptyExploreQueryError();
  }

  const id = options?.id ?? `explore-${base36Stamp()}-${base36Rand()}`;

  // Build a structured exploration plan from the query.
  // Every plan includes at minimum: list-roots + search, then read + summarize.
  // The plan is re-parsed through the schema before return so the builder
  // never returns a value that fails the public schema contract.

  const steps: ExplorePlanStep[] = [
    {
      kind: "list-roots",
      id: `${id}-step-1`,
      label: "List project roots and entry points",
      roots: ["."]
    },
    {
      kind: "search",
      id: `${id}-step-2`,
      label: `Search codebase for patterns matching: ${query}`,
      search: query
    },
    {
      kind: "read",
      id: `${id}-step-3`,
      label: "Read the most relevant files found by search",
      files: [] // caller / downstream planner fills these in from search results
    },
    {
      kind: "summarize",
      id: `${id}-step-4`,
      label: "Summarize findings from list-roots, search, and read",
      summarize: `Produce a structured summary of findings for query: ${query}`
    }
  ];

  const plan: z.input<typeof ExploreCodebasePlanSchema> = {
    id,
    steps,
    describesOnly: true,
    query
  };

  // Re-parse through the output schema to validate shape before return.
  return ExploreCodebasePlanSchema.parse(plan);
}