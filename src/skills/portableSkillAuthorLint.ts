import { z } from "zod";

/**
 * Portable skill author lint: reject vendor-locked path tokens in skill bodies.
 * A skill that ships with a vendor-specific home path should use generic
 * references or relative paths instead.
 */

// Vendor-locked path patterns.

/**
 * Each entry matches a case-insensitive vendor configuration root in a skill
 * body. A match warns because the author can remap the path.
 */
const VENDOR_PATH_TOKENS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly vendor: string;
  readonly hint: string;
}> = [
  {
    pattern: /~\/\.claude(?:\/|$)/gim,
    vendor: "Claude Code",
    hint: "Replace ~/.claude with a portable relative path or a tool-relative reference."
  },
  {
    pattern: /~\/\.codex(?:\/|$)/gim,
    vendor: "OpenAI Codex",
    hint: "Replace ~/.codex with a portable relative path or a tool-relative reference."
  },
  {
    pattern: /~\/\.cursor(?:\/|$)/gim,
    vendor: "Cursor IDE",
    hint: "Replace ~/.cursor with a portable relative path or a tool-relative reference."
  },
  {
    pattern: /~\/\.windsurf(?:\/|$)/gim,
    vendor: "Windsurf IDE",
    hint: "Replace ~/.windsurf with a portable relative path or a tool-relative reference."
  }
];

// ── schemas ─────────────────────────────────────────────────────────────────

export const LintWarningSchema = z
  .object({
    vendor: z.string().min(1).describe("Which vendor/harness the path locks the skill to."),
    token: z.string().min(1).describe("The matched vendor-path substring."),
    hint: z.string().min(1).describe("Actionable guidance for the skill author.")
  })
  .strict();
export type LintWarning = z.infer<typeof LintWarningSchema>;

export const PortableSkillLintResultSchema = z
  .object({
    ok: z.boolean().describe("true when zero vendor-path warnings were found."),
    warnings: z.array(LintWarningSchema).describe("Vendor-locked path tokens found in the skill body.")
  })
  .strict();
export type PortableSkillLintResult = z.infer<typeof PortableSkillLintResultSchema>;

// ── lint ────────────────────────────────────────────────────────────────────

/** Scan a skill body for vendor-locked path tokens. */
export function lintSkillBody(body: string): PortableSkillLintResult {
  const warnings: LintWarning[] = [];

  for (const { pattern, vendor, hint } of VENDOR_PATH_TOKENS) {
    // Reset regex state (global flag caches lastIndex).
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const token = match[0]!.trim();
      warnings.push({ vendor, token, hint });
    }
  }

  return PortableSkillLintResultSchema.parse({
    ok: warnings.length === 0,
    warnings
  });
}
