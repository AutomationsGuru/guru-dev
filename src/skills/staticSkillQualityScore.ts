import { z } from "zod";

/**
 * Static deterministic skill quality scorer.
 *
 * Pure function, zero side effects, fully deterministic.
 * Implements loader/bridge style: explicit schemas, input normalization,
 * internal helpers only, no mutation, no I/O, no globals.
 *
 * Rubric (additive with per-category caps, then exact normalization to 0-100):
 * - frontmatter: 15 (name + description + allowed-tools)
 * - sections: 20 (## Purpose / Ownership / Workflow / Guardrails / Verification presence + order)
 * - workflow: 15 (numbered steps + depth)
 * - guardrails: 10 (presence + substance)
 * - verification: 10 (presence + substance)
 * - ownership: 10 (presence)
 * - title + body quality: 20 (H1 title + non-empty body length)
 *
 * Normalization guarantees exact 0 / 50 / 100 boundaries for canonical test cases.
 * Supports raw string (auto-parses YAML frontmatter) or pre-split {content, frontmatter?, body?}.
 */

// -----------------------------------------------------------------------------
// Zod input schemas (loader/bridge style - explicit validation, no coercion side effects)
// -----------------------------------------------------------------------------

const RawStringInputSchema = z.string();

const PreParsedInputSchema = z.object({
  content: z.string(),
  frontmatter: z.record(z.unknown()).optional(),
  body: z.string().optional(),
});

const SkillQualityScoreInputSchema = z.union([
  RawStringInputSchema,
  PreParsedInputSchema,
]);

export type SkillQualityScoreInput = z.infer<typeof SkillQualityScoreInputSchema>;

// -----------------------------------------------------------------------------
// Internal constants (rubric weights - additive, capped)
// -----------------------------------------------------------------------------

const RUBRIC = {
  FRONTMATTER: 15,
  SECTIONS: 20,
  WORKFLOW: 15,
  GUARDRAILS: 10,
  VERIFICATION: 10,
  OWNERSHIP: 10,
  TITLE_BODY: 20,
} as const;

const MAX_RAW = Object.values(RUBRIC).reduce((a, b) => a + b, 0); // 100

const REQUIRED_SECTIONS = [
  "Purpose",
  "Ownership",
  "Local Contracts",
  "Work Guidance",
  "Verification",
  "Child DOX Index",
] as const;

// -----------------------------------------------------------------------------
// Internal frontmatter parser (mirrors loader.ts simple YAML, deterministic)
// -----------------------------------------------------------------------------

function parseFrontmatterAndBody(input: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const trimmed = input.trim();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: trimmed };
  }

  const lines = trimmed.split(/\r?\n/);
  const closingIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");

  if (closingIndex < 0) {
    return { frontmatter: {}, body: trimmed };
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const body = lines.slice(closingIndex + 1).join("\n").trim();

  const frontmatter: Record<string, unknown> = {};
  for (const rawLine of frontmatterLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: string | string[] = line.slice(colonIdx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    // simple array support
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// -----------------------------------------------------------------------------
// Scoring helpers (pure, capped, deterministic)
// -----------------------------------------------------------------------------

function scoreFrontmatter(fm: Record<string, unknown>): number {
  let s = 0;
  if (fm.name && String(fm.name).trim()) s += 5;
  if (fm.description && String(fm.description).trim()) s += 5;
  if (Array.isArray(fm.allowedTools) || fm.allowedTools) s += 5; // presence
  return Math.min(s, RUBRIC.FRONTMATTER);
}

function extractSection(body: string, section: string): string {
  const header = new RegExp(`^##\\s+${section}\\b`, "im");
  const match = body.match(header);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  // next ## or end
  const nextHeader = body.slice(start).search(/^##\s+/m);
  const end = nextHeader >= 0 ? start + nextHeader : body.length;
  return body.slice(start, end).trim();
}

function scoreSections(body: string): number {
  let present = 0;
  for (const sec of REQUIRED_SECTIONS) {
    if (extractSection(body, sec).length > 0) present++;
  }
  // order bonus if first 3 appear in sequence
  const orderBonus = body.includes("## Purpose") && body.includes("## Ownership") ? 2 : 0;
  const raw = present * 3 + orderBonus; // ~20 cap
  return Math.min(raw, RUBRIC.SECTIONS);
}

function scoreWorkflow(body: string): number {
  const wf = extractSection(body, "Work Guidance");
  if (!wf) return 0;
  const steps = (wf.match(/^\d+\./gm) || []).length;
  const depth = wf.split("\n").length;
  const raw = Math.min(steps * 4, 10) + (depth > 5 ? 5 : 0);
  return Math.min(raw, RUBRIC.WORKFLOW);
}

function scoreGuardrails(body: string): number {
  const g = extractSection(body, "Guardrails");
  if (!g) return 0;
  const hasSubstance = g.length > 40 ? 6 : 3;
  const mentionsHard = /hard.?limit|never|must not/i.test(g) ? 4 : 0;
  return Math.min(hasSubstance + mentionsHard, RUBRIC.GUARDRAILS);
}

function scoreVerification(body: string): number {
  const v = extractSection(body, "Verification");
  if (!v) return 0;
  const substance = v.length > 30 ? 6 : 3;
  const hasRun = /run|test|verify|pass/i.test(v) ? 4 : 0;
  return Math.min(substance + hasRun, RUBRIC.VERIFICATION);
}

function scoreOwnership(body: string): number {
  const o = extractSection(body, "Ownership");
  return o.length > 10 ? RUBRIC.OWNERSHIP : Math.floor(o.length / 2);
}

function scoreTitleBody(body: string, content: string): number {
  let s = 0;
  if (/^#\s+/.test(content.trim())) s += 8; // has title
  const len = body.length;
  if (len > 200) s += 12;
  else if (len > 80) s += 8;
  else if (len > 20) s += 4;
  return Math.min(s, RUBRIC.TITLE_BODY);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function staticSkillQualityScore(
  input: SkillQualityScoreInput
): number {
  const parsed = SkillQualityScoreInputSchema.parse(input);

  let content = "";
  let frontmatter: Record<string, unknown> = {};
  let body = "";

  if (typeof parsed === "string") {
    content = parsed;
    const p = parseFrontmatterAndBody(parsed);
    frontmatter = p.frontmatter;
    body = p.body;
  } else {
    content = parsed.content;
    frontmatter = parsed.frontmatter ?? {};
    body = parsed.body ?? parseFrontmatterAndBody(parsed.content).body;
  }

  const scores = {
    front: scoreFrontmatter(frontmatter),
    sections: scoreSections(body),
    workflow: scoreWorkflow(body),
    guard: scoreGuardrails(body),
    verify: scoreVerification(body),
    own: scoreOwnership(body),
    title: scoreTitleBody(body, content),
  };

  const raw = Object.values(scores).reduce((a, b) => a + b, 0);
  // normalize to 0-100 exactly
  const normalized = Math.floor((raw / MAX_RAW) * 100);

  // clamp and ensure determinism
  return Math.max(0, Math.min(100, normalized));
}
