/**
 * specAnalyzeGaps
 *
 * Spec analyze gaps: a small, dependency-free requirements/spec text analyzer.
 * It detects two classes of gap in requirements prose:
 *
 *   1. **ambiguity-keyword** — vague language ("TBD", "somehow", "maybe") that
 *      signals an under-specified requirement and resists verification.
 *   2. **missing-acceptance-criteria** — a requirement line that carries no
 *      observable acceptance marker (AC:, Acceptance Criteria:, Should:, or a
 *      Given/When/Then clause), so it cannot be verified as met.
 *
 * This module is a pure function over text. It owns no runtime, edits no core,
 * and introduces no external dependency — it registers a small spec-quality
 * capability as an inspectable, testable building block. It is intended to be
 * composed by the requirements-lint (F151) and spec (F136) surfaces rather than
 * imported into the kernel.
 */

/** Categories of gap the analyzer can report. */
export type SpecGapKind =
  | "ambiguity-keyword"
  | "missing-acceptance-criteria";

/** Repairable lints are warnings; reserved for future hard failures. */
export type SpecGapSeverity = "warning" | "error";

/** A single detected gap in the analyzed text. */
export interface SpecGap {
  /** Which class of gap was detected. */
  readonly kind: SpecGapKind;
  /** Human-readable explanation of the gap. */
  readonly message: string;
  /** Matched ambiguity keyword, when `kind === "ambiguity-keyword"`. */
  readonly keyword?: string;
  /** Excerpt of the offending line for fast human triage. */
  readonly snippet: string;
  /** 1-based line number in the source text. */
  readonly line: number;
  /** 1-based column number of the match (keyword or requirement id). */
  readonly column: number;
  readonly severity: SpecGapSeverity;
}

/**
 * Vague language that signals an under-specified requirement. Matched
 * case-insensitively and as whole words only, so words like "alumnaybe" do not
 * produce false positives.
 */
const AMBIGUITY_KEYWORDS: readonly string[] = ["TBD", "somehow", "maybe"];

/**
 * Acceptance-criteria markers. A requirement line is considered to carry an
 * acceptance criterion when any of these appears anywhere in the text.
 * Markers are matched case-insensitively as whole-word or label boundaries.
 */
const ACCEPTANCE_MARKERS: readonly RegExp[] = [
  /\bAC\b\s*:/i,
  /\bAcceptance\s+Criteria\b\s*:/i,
  /\bShould\b\s*:/i,
  /\bGiven\b.+\bWhen\b.+\bThen\b/is
];

/** Lines that look like a requirement statement (an ID prefix or a verb lead). */
const REQUIREMENT_LINE = /^\s*(?:REQ[-\s]?\d+|Requirement[-\s]?\d+|FR[-\s]?\d+|US[-\s]?\d+)\b/i;

/** Trailing context shown in a gap snippet, kept short for triage. */
const SNIPPET_MAX = 120;

function truncateSnippet(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= SNIPPET_MAX) {
    return trimmed;
  }
  return `${trimmed.slice(0, SNIPPET_MAX - 1)}…`;
}

function hasAcceptanceMarker(text: string): boolean {
  return ACCEPTANCE_MARKERS.some((re) => re.test(text));
}

/**
 * Analyze requirements/spec text and return the gaps it finds, sorted by line
 * then column in a stable order. Empty or whitespace-only text yields no gaps.
 *
 * Ambiguity keywords are de-duplicated per (line, keyword) so a keyword that
 * appears twice on one line is reported once. A missing-acceptance-criteria gap
 * is emitted once per requirement line that lacks any acceptance marker.
 */
export function analyzeSpecGaps(text: string): SpecGap[] {
  if (typeof text !== "string" || text.trim().length === 0) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const gaps: SpecGap[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      return;
    }

    // Ambiguity keywords — whole-word, case-insensitive, de-duplicated per line.
    const seenOnLine = new Set<string>();
    for (const keyword of AMBIGUITY_KEYWORDS) {
      const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "gi");
      const match = pattern.exec(line);
      if (match && !seenOnLine.has(keyword.toLowerCase())) {
        seenOnLine.add(keyword.toLowerCase());
        gaps.push({
          kind: "ambiguity-keyword",
          keyword: match[0],
          message: `Ambiguity keyword "${match[0]}" signals an under-specified requirement.`,
          snippet: truncateSnippet(line),
          line: lineNumber,
          column: match.index + 1,
          severity: "warning"
        });
      }
    }

    // Missing acceptance criteria — only for lines that look like requirements.
    if (REQUIREMENT_LINE.test(line) && !hasAcceptanceMarker(text)) {
      gaps.push({
        kind: "missing-acceptance-criteria",
        message:
          "Requirement lacks an acceptance-criteria marker (e.g. \"AC:\", \"Acceptance Criteria:\", \"Should:\", or a Given/When/Then clause).",
        snippet: truncateSnippet(line),
        line: lineNumber,
        column: 1,
        severity: "warning"
      });
    }
  });

  gaps.sort((a, b) =>
    a.line === b.line ? a.column - b.column : a.line - b.line
  );
  return gaps;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
