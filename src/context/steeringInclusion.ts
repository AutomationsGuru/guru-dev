/**
 * Steering inclusion resolver (IDEA-F137-STEERING-INCL-01).
 *
 * Given a list of `SteeringDoc` instances and a `SteeringContext`, decide
 * which docs apply and in what order:
 *
 *   - `always`    → always selected (reason: "always-on")
 *   - `manual`    → selected iff `ctx.manualRefs` includes the doc id
 *   - `fileMatch` → selected iff `ctx.activePath` matches any glob pattern
 *   - `auto`      → selected iff `ctx.userQuery` mentions a description keyword
 *
 * The output preserves the input order across modes. Within a single doc the
 * reason is the FIRST rule that selected it (modes are evaluated in the order
 * above). Docs whose `mode` is invalid are skipped defensively.
 */
import {
  InclusionModeSchema,
  type InclusionMode,
  ResolvedSteeringSchema,
  type ResolvedSteering,
  type SteeringDoc
} from "./steeringInclusionSchema.js";

const STOP_WORD_MAX_LENGTH = 2;

/**
 * Loose input shape accepted by `resolveSteering`. Every field is optional;
 * `manualRefs` defaults to an empty array. Accepting a partial shape here
 * keeps callers from having to round-trip their context through the strict
 * `SteeringContextSchema` before calling the resolver.
 */
export interface ResolveSteeringContext {
  readonly activePath?: string;
  readonly userQuery?: string;
  readonly manualRefs?: readonly string[];
}

interface NormalizedContext {
  readonly activePath: string | undefined;
  readonly userQuery: string | undefined;
  readonly manualRefs: readonly string[];
}

export function resolveSteering(
  docs: readonly SteeringDoc[],
  contextInput: ResolveSteeringContext = {}
): ResolvedSteering {
  const ctx: NormalizedContext = {
    activePath: contextInput.activePath,
    userQuery: contextInput.userQuery,
    manualRefs: contextInput.manualRefs ?? []
  };
  const manualRefSet = new Set(ctx.manualRefs);
  const normalizedQuery = ctx.userQuery ? ctx.userQuery.toLowerCase() : undefined;

  const selected: ResolvedSteering["selected"] = [];

  for (const doc of docs) {
    const modeParse = InclusionModeSchema.safeParse(doc.mode);
    if (!modeParse.success) {
      continue;
    }
    const mode = modeParse.data;

    const decision = evaluateDoc(doc, mode, ctx, manualRefSet, normalizedQuery);
    if (!decision) {
      continue;
    }

    selected.push({
      id: doc.id,
      mode,
      content: doc.content,
      body: doc.body ?? "",
      reason: decision
    });
  }

  return ResolvedSteeringSchema.parse({ selected });
}

function evaluateDoc(
  doc: SteeringDoc,
  mode: InclusionMode,
  ctx: NormalizedContext,
  manualRefSet: ReadonlySet<string>,
  normalizedQuery: string | undefined
): string | undefined {
  switch (mode) {
    case "always":
      return "always-on";
    case "manual":
      return manualRefSet.has(doc.id) ? "manual" : undefined;
    case "fileMatch": {
      const match = matchFileMatch(doc, ctx.activePath);
      return match ? `file-match:${match}` : undefined;
    }
    case "auto": {
      const keyword = matchAutoKeyword(doc.description, normalizedQuery);
      return keyword ? `auto:${keyword}` : undefined;
    }
    default:
      return undefined;
  }
}

function matchFileMatch(doc: SteeringDoc, activePath: string | undefined): string | undefined {
  if (!activePath || !doc.fileMatch || doc.fileMatch.length === 0) {
    return undefined;
  }

  for (const pattern of doc.fileMatch) {
    if (matchesGlob(pattern, activePath)) {
      return pattern;
    }
  }
  return undefined;
}

function matchAutoKeyword(description: string | undefined, normalizedQuery: string | undefined): string | undefined {
  if (!description || !normalizedQuery) {
    return undefined;
  }

  const keywords = description
    .split(/\s+/)
    .map((word) => stripPunctuation(word.toLowerCase()))
    .filter((word) => word.length > STOP_WORD_MAX_LENGTH);

  // Prefer the longest matching keyword so that more specific terms win over
  // generic ones when the user query mentions several description words.
  let best: string | undefined;
  for (const keyword of keywords) {
    if (!normalizedQuery.includes(keyword)) {
      continue;
    }
    if (!best || keyword.length > best.length) {
      best = keyword;
    }
  }
  return best;
}

function stripPunctuation(word: string): string {
  // Trim common punctuation that wouldn't survive a `includes()` substring
  // match against natural-language queries anyway.
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Tiny glob matcher supporting `*` (single segment) and `**` (any depth).
 *
 * Patterns are split on `/`. A `**` segment matches zero or more path segments;
 * a `*` segment matches any characters within a single segment. All other
 * segments are matched literally. A pattern without `/` matches the trailing
 * segment of the active path (so `*.ts` matches `foo.ts` and `dir/foo.ts`).
 */
export function matchesGlob(pattern: string, value: string): boolean {
  const patternSegments = pattern.split("/").filter((segment) => segment.length > 0);
  const valueSegments = value.split("/").filter((segment) => segment.length > 0);

  if (patternSegments.length === 0) {
    return false;
  }

  // Anchored patterns (with leading slash) match from the root; relative
  // patterns are matched against the trailing segments of the value.
  const anchored = pattern.startsWith("/");
  const startValueIndex = anchored ? 0 : Math.max(0, valueSegments.length - patternSegments.length);

  return matchSegments(patternSegments, 0, valueSegments, startValueIndex);
}

function matchSegments(
  pattern: readonly string[],
  patternIndex: number,
  value: readonly string[],
  valueIndex: number
): boolean {
  if (patternIndex === pattern.length) {
    return valueIndex === value.length;
  }

  const segment = pattern[patternIndex];
  if (segment === undefined) {
    return false;
  }

  if (segment === "**") {
    // Try matching `**` against 0..remaining segments.
    for (let skip = valueIndex; skip <= value.length; skip += 1) {
      if (matchSegments(pattern, patternIndex + 1, value, skip)) {
        return true;
      }
    }
    return false;
  }

  if (valueIndex >= value.length) {
    return false;
  }

  const valueSegment = value[valueIndex];
  if (valueSegment === undefined) {
    return false;
  }

  if (!matchSingleSegment(segment, valueSegment)) {
    return false;
  }

  return matchSegments(pattern, patternIndex + 1, value, valueIndex + 1);
}

function matchSingleSegment(patternSegment: string, valueSegment: string): boolean {
  if (patternSegment === "*") {
    return valueSegment.length > 0;
  }
  return matchWildcard(patternSegment, valueSegment);
}

function matchWildcard(pattern: string, value: string): boolean {
  // Translate glob `*` (NOT `**`) into a regex anchored on both sides.
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") {
      regex += "[^/]*";
    } else if (/[\\^$.+?()[\]{}|]/.test(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  regex += "$";
  return new RegExp(regex).test(value);
}