import { z } from "zod";

/**
 * Eval harness fixture — compares an expected tool-call sequence (the fixture)
 * against an actual recorded sequence and reports every mismatch with evidence.
 *
 * Honesty rule: a mismatch is never smoothed over — the report names the exact
 * index, what was expected, and what was actually observed, so eval failures
 * stay legible instead of collapsing into a bare pass/fail. No LangSmith or
 * other external service is required; comparison is pure and in-process.
 */

export const ToolCallFixtureEntrySchema = z.object({
  tool: z.string().min(1),
  /** Expected/recorded arguments, compared with strict deep equality when present. */
  args: z.unknown().optional()
});
export type ToolCallFixtureEntry = z.infer<typeof ToolCallFixtureEntrySchema>;

export const ToolSequenceFixtureSchema = z.object({
  name: z.string().min(1),
  expected: z.array(ToolCallFixtureEntrySchema)
});
export type ToolSequenceFixture = z.infer<typeof ToolSequenceFixtureSchema>;

export const ToolSequenceMismatchKindSchema = z.enum(["wrong-tool", "wrong-args", "missing", "unexpected"]);
export type ToolSequenceMismatchKind = z.infer<typeof ToolSequenceMismatchKindSchema>;

export const ToolSequenceMismatchSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: ToolSequenceMismatchKindSchema,
  expected: ToolCallFixtureEntrySchema.optional(),
  actual: ToolCallFixtureEntrySchema.optional()
});
export type ToolSequenceMismatch = z.infer<typeof ToolSequenceMismatchSchema>;

export const ToolSequenceComparisonSchema = z.object({
  match: z.boolean(),
  expectedLength: z.number().int().nonnegative(),
  actualLength: z.number().int().nonnegative(),
  mismatches: z.array(ToolSequenceMismatchSchema)
});
export type ToolSequenceComparison = z.infer<typeof ToolSequenceComparisonSchema>;

/** Loads and validates a fixture of the expected tool sequence. */
export function loadToolSequenceFixture(raw: unknown): ToolSequenceFixture {
  return ToolSequenceFixtureSchema.parse(raw);
}

function argsEqual(expected: unknown, actual: unknown): boolean {
  return JSON.stringify(expected ?? null) === JSON.stringify(actual ?? null);
}

/**
 * Compares the expected tool sequence against the actual sequence, pairwise by
 * index. Length differences surface as `missing` (expected but absent) or
 * `unexpected` (recorded but not expected) trailing mismatches — no silent
 * truncation in either direction.
 */
export function compare(
  expected: readonly ToolCallFixtureEntry[],
  actual: readonly ToolCallFixtureEntry[]
): ToolSequenceComparison {
  const mismatches: ToolSequenceMismatch[] = [];
  const shared = Math.min(expected.length, actual.length);

  for (let index = 0; index < shared; index += 1) {
    const expectedEntry = expected[index]!;
    const actualEntry = actual[index]!;
    if (expectedEntry.tool !== actualEntry.tool) {
      mismatches.push({ index, kind: "wrong-tool", expected: expectedEntry, actual: actualEntry });
    } else if (!argsEqual(expectedEntry.args, actualEntry.args)) {
      mismatches.push({ index, kind: "wrong-args", expected: expectedEntry, actual: actualEntry });
    }
  }

  for (let index = shared; index < expected.length; index += 1) {
    mismatches.push({ index, kind: "missing", expected: expected[index]! });
  }
  for (let index = shared; index < actual.length; index += 1) {
    mismatches.push({ index, kind: "unexpected", actual: actual[index]! });
  }

  return {
    match: mismatches.length === 0,
    expectedLength: expected.length,
    actualLength: actual.length,
    mismatches
  };
}

/** Renders a comparison as one human-readable line per mismatch, for eval reports. */
export function formatMismatches(comparison: ToolSequenceComparison): string[] {
  return comparison.mismatches.map((mismatch) => {
    switch (mismatch.kind) {
      case "wrong-tool":
        return `[${mismatch.index}] wrong-tool: expected "${mismatch.expected?.tool}", got "${mismatch.actual?.tool}"`;
      case "wrong-args":
        return `[${mismatch.index}] wrong-args for "${mismatch.expected?.tool}"`;
      case "missing":
        return `[${mismatch.index}] missing: expected "${mismatch.expected?.tool}" was never called`;
      case "unexpected":
        return `[${mismatch.index}] unexpected: "${mismatch.actual?.tool}" was not in the fixture`;
    }
  });
}
