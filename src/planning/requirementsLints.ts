/**
 * Requirements lints (IDEA-F151-REQ-LINTS-01, R-KR-REQLINT — kiro-cli analyze
 * requirements residual; composes the F136 spec packet).
 *
 * Pure, dependency-free checks over requirements document text (the markdown
 * requirements artifact of a spec packet): empty acceptance criteria,
 * duplicate user stories, and — for bugfix specs — a missing expected-behavior
 * statement. No I/O, no model calls; callers lint whatever text they hold.
 */

/** Stable machine-readable lint codes for callers that gate or report. */
export const REQUIREMENTS_LINT_CODES = {
  /** A required section (e.g. Acceptance Criteria) is absent from the document. */
  missingSection: "missing-section",
  /** The Acceptance Criteria section exists but contains no entries. */
  emptyAcceptanceCriteria: "empty-acceptance-criteria",
  /** An Acceptance Criteria bullet is present but carries no text. */
  emptyAcceptanceCriterion: "empty-acceptance-criterion",
  /** Two user stories normalize to the same text (case/punctuation-insensitive). */
  duplicateUserStory: "duplicate-user-story",
  /** A bugfix requirements document states no expected behavior. */
  missingExpectedBehavior: "missing-expected-behavior"
} as const;
export type RequirementsLintCode =
  (typeof REQUIREMENTS_LINT_CODES)[keyof typeof REQUIREMENTS_LINT_CODES];

/** Spec kind from the F136 packet model; controls which lints apply. */
export type RequirementsSpecKind = "feature" | "bugfix";

export interface RequirementsLintOptions {
  /**
   * Spec kind. When omitted, the document is sniffed: a top-level heading
   * containing "bugfix"/"bug fix" selects bugfix, otherwise feature.
   */
  readonly kind?: RequirementsSpecKind;
}

export interface RequirementsLintIssue {
  readonly code: RequirementsLintCode;
  /** One-based line the issue anchors to, when one exists. */
  readonly line?: number;
  readonly message: string;
}

interface Section {
  readonly title: string;
  readonly headingLine: number;
  /** Lines after the heading, up to the next heading of same-or-higher level. */
  readonly body: readonly string[];
  /** One-based line number of body[0]. */
  readonly bodyStartLine: number;
}

/** Match a markdown ATX heading: `#`..`######` + space + title. */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
/** Match a list bullet: `-`, `*`, or `+` marker, possibly with empty text. */
const BULLET_RE = /^\s*[-*+]\s*(.*)$/;
const BUGFIX_TITLE_RE = /bug\s*-?\s*fix/i;

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

/** Normalize a story/criterion for comparison: case, punctuation, and whitespace collapse. */
function normalizeEntry(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Split the document into heading-anchored sections. A section ends at the
 * next heading of the same or higher level, so nested subsections stay inside
 * their parent. Documents with no headings yield zero sections.
 */
function splitSections(lines: readonly string[]): Section[] {
  const headings: { level: number; title: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING_RE.exec(lines[i] ?? "");
    if (match) {
      headings.push({ level: match[1]!.length, title: match[2]!, line: i + 1 });
    }
  }

  const sections: Section[] = [];
  for (let h = 0; h < headings.length; h += 1) {
    const heading = headings[h]!;
    let end = lines.length;
    for (let n = h + 1; n < headings.length; n += 1) {
      if (headings[n]!.level <= heading.level) {
        end = headings[n]!.line - 1;
        break;
      }
    }
    sections.push({
      title: heading.title,
      headingLine: heading.line,
      body: lines.slice(heading.line, end),
      bodyStartLine: heading.line + 1
    });
  }
  return sections;
}

function findSection(sections: readonly Section[], ...names: string[]): Section | undefined {
  const wanted = names.map(normalizeTitle);
  return sections.find((section) => wanted.includes(normalizeTitle(section.title)));
}

/** Bullet entries of a section, with one-based source lines. */
function sectionBullets(section: Section): { text: string; line: number }[] {
  const bullets: { text: string; line: number }[] = [];
  section.body.forEach((bodyLine, index) => {
    const match = BULLET_RE.exec(bodyLine);
    if (match) {
      bullets.push({ text: match[1] ?? "", line: section.bodyStartLine + index });
    }
  });
  return bullets;
}

function detectKind(lines: readonly string[]): RequirementsSpecKind {
  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match && BUGFIX_TITLE_RE.test(match[2]!)) {
      return "bugfix";
    }
  }
  return "feature";
}

/**
 * Lint requirements document text. Pure: same input always yields an equal
 * fresh issue array; nothing is read, written, or mutated.
 */
export function lintRequirements(
  requirementsText: string,
  options: RequirementsLintOptions = {}
): RequirementsLintIssue[] {
  const lines = requirementsText.split(/\r?\n/);
  const sections = splitSections(lines);
  const kind = options.kind ?? detectKind(lines);
  const issues: RequirementsLintIssue[] = [];

  const userStories = findSection(sections, "user stories", "user story");
  const acceptanceCriteria = findSection(
    sections,
    "acceptance criteria",
    "acceptance criterion"
  );
  const expectedBehavior = findSection(
    sections,
    "expected behavior",
    "expected behaviour"
  );

  // --- Missing sections -------------------------------------------------
  if (!userStories) {
    issues.push({
      code: REQUIREMENTS_LINT_CODES.missingSection,
      message: "Requirements document has no User Stories section."
    });
  }
  if (!acceptanceCriteria) {
    issues.push({
      code: REQUIREMENTS_LINT_CODES.missingSection,
      message: "Requirements document has no Acceptance Criteria section."
    });
  }

  // --- Empty acceptance criteria ----------------------------------------
  if (acceptanceCriteria) {
    const bullets = sectionBullets(acceptanceCriteria);
    if (bullets.length === 0) {
      issues.push({
        code: REQUIREMENTS_LINT_CODES.emptyAcceptanceCriteria,
        line: acceptanceCriteria.headingLine,
        message: "Acceptance Criteria section contains no criteria."
      });
    }
    for (const bullet of bullets) {
      if (normalizeEntry(bullet.text) === "") {
        issues.push({
          code: REQUIREMENTS_LINT_CODES.emptyAcceptanceCriterion,
          line: bullet.line,
          message: "Acceptance criterion bullet is empty."
        });
      }
    }
  }

  // --- Duplicate user stories --------------------------------------------
  if (userStories) {
    const seen = new Map<string, number>();
    for (const bullet of sectionBullets(userStories)) {
      const normalized = normalizeEntry(bullet.text);
      if (normalized === "") {
        continue;
      }
      const firstLine = seen.get(normalized);
      if (firstLine !== undefined) {
        issues.push({
          code: REQUIREMENTS_LINT_CODES.duplicateUserStory,
          line: bullet.line,
          message: `Duplicate user story (first declared at line ${firstLine}): "${bullet.text.trim()}".`
        });
      } else {
        seen.set(normalized, bullet.line);
      }
    }
  }

  // --- Bugfix documents must state expected behavior ---------------------
  if (kind === "bugfix") {
    const hasExpectedBehavior =
      expectedBehavior !== undefined &&
      (sectionBullets(expectedBehavior).some((bullet) => normalizeEntry(bullet.text) !== "") ||
        expectedBehavior.body.some((bodyLine) => normalizeEntry(bodyLine) !== ""));
    if (!hasExpectedBehavior) {
      issues.push({
        code: REQUIREMENTS_LINT_CODES.missingExpectedBehavior,
        ...(expectedBehavior ? { line: expectedBehavior.headingLine } : {}),
        message: expectedBehavior
          ? "Bugfix requirements Expected Behavior section is empty."
          : "Bugfix requirements document has no Expected Behavior section."
      });
    }
  }

  return issues;
}
