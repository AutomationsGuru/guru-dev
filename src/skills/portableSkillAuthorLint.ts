/**
 * Portable skill author lint (§F410).
 *
 * Scans a skill body for vendor-locked path tokens — references to a specific AI
 * harness vendor's home-directory config (e.g. `~/.claude`, `~/.codex`) — so
 * authors can rewrite them as portable paths before publishing.
 *
 * A vendor-locked path ties a skill to one harness; a portable skill uses
 * `~/.guruharness` (GuruHarness's own home) or generic paths.  This lint is a
 * development-time authoring aid, not a runtime gate.
 */

/** A single vendor-locked path warning with enough context for the author to fix it. */
export interface VendorPathWarning {
  /** The matched vendor path token (e.g. "~/.claude"). */
  readonly path: string;
  /** The vendor this path locks the skill to. */
  readonly vendor: string;
  /** Human-readable warning message citing the path and vendor. */
  readonly message: string;
  /** A suggested portable replacement (e.g. "~/.guruharness"). */
  readonly suggestion: string;
}

/** One registered vendor-path pattern and its metadata. */
interface VendorEntry {
  readonly regex: RegExp;
  readonly vendor: string;
  readonly path: string;
  readonly suggestion: string;
}

const GURUHARNESS_HOME = "~/.guruharness";

/**
 * Registered vendor-locked path patterns.
 *
 * Each entry matches a path token that ties a skill body to one specific AI
 * harness vendor.  Patterns use `\b` word-boundary at the end so `~/.claude`
 * flags but `~/.claudette` does not.
 *
 * Add new entries here when another vendor's config path appears in the wild.
 * Never add `~/.guruharness` — that is the portable target, not a lock.
 */
const VENDOR_ENTRIES: readonly VendorEntry[] = [
  // Anthropic Claude — various forms
  {
    regex: /~\/\.claude\b/,
    vendor: "Anthropic Claude",
    path: "~/.claude",
    suggestion: GURUHARNESS_HOME,
  },
  {
    regex: /\$HOME\/\.claude\b/,
    vendor: "Anthropic Claude",
    path: "$HOME/.claude",
    suggestion: GURUHARNESS_HOME,
  },
  {
    regex: /~\/\.config\/claude\b/,
    vendor: "Anthropic Claude",
    path: "~/.config/claude",
    suggestion: GURUHARNESS_HOME,
  },
  // OpenAI Codex — various forms
  {
    regex: /~\/\.codex\b/,
    vendor: "OpenAI Codex",
    path: "~/.codex",
    suggestion: GURUHARNESS_HOME,
  },
  {
    regex: /~\/\.config\/codex\b/,
    vendor: "OpenAI Codex",
    path: "~/.config/codex",
    suggestion: GURUHARNESS_HOME,
  },
  // Anthropic general
  {
    regex: /~\/\.anthropic\b/,
    vendor: "Anthropic",
    path: "~/.anthropic",
    suggestion: GURUHARNESS_HOME,
  },
  // OpenAI general
  {
    regex: /~\/\.openai\b/,
    vendor: "OpenAI",
    path: "~/.openai",
    suggestion: GURUHARNESS_HOME,
  },
];

/**
 * Lint a skill body for vendor-locked path tokens.
 *
 * Returns zero or more warnings, one per unique vendor path found.  Repeated
 * mentions of the same vendor path are deduplicated so the author sees each
 * lock once.
 */
export function lintPortableSkill(body: string): VendorPathWarning[] {
  const seen = new Set<string>();
  const warnings: VendorPathWarning[] = [];

  for (const entry of VENDOR_ENTRIES) {
    if (entry.regex.test(body)) {
      if (seen.has(entry.path)) {
        continue;
      }
      seen.add(entry.path);
      warnings.push({
        path: entry.path,
        vendor: entry.vendor,
        message: `Vendor-locked path "${entry.path}" (${entry.vendor}) found in skill body — replace with a portable path such as "${entry.suggestion}".`,
        suggestion: entry.suggestion,
      });
    }
  }

  return warnings;
}
