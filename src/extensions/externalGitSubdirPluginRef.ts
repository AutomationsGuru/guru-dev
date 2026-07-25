import { z } from "zod";

/**
 * External git-subdir plugin reference.
 *
 * Records {repo, subdir, pin} for an external capability without cloning —
 * the pin is validated for format but the repo is never fetched at ref-parse
 * time. The caller decides when (and whether) to materialize.
 *
 * Part of the F409 GITSUB capability surface; composes with the garage
 * manifest via a gap record (ATTACH) until a native replacement ships.
 */

// ---------------------------------------------------------------------------
// Pin validation
// ---------------------------------------------------------------------------

/**
 * Valid git refs: full SHA (40 hex), short SHA (7–40 hex), or a ref-path /
 * tag / branch name composed of alphanumeric, `/`, `-`, `_`, `.`.
 *
 * One leading `refs/(heads|tags|remotes)/` prefix is allowed but not required.
 * Empty and whitespace-only strings are rejected.
 */
const GIT_REF_RE =
  /^(?:refs\/(?:heads|tags|remotes)\/)?[0-9a-f]{7,40}$|^(?:refs\/(?:heads|tags|remotes)\/)?[\w.\-/]+$/u;

const GIT_REF_MAX_LENGTH = 255;

function isValidGitRef(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > GIT_REF_MAX_LENGTH) return false;
  return GIT_REF_RE.test(trimmed);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ExternalGitSubdirPluginRefSchema = z
  .object({
    /** Repository URL or path. Must be non-empty. */
    repo: z.string().trim().min(1),
    /**
     * Subdirectory within the repository that contains the plugin root.
     * Empty string or "." means the repo root. Must not be an absolute path.
     */
    subdir: z
      .string()
      .trim()
      .default("")
      .refine((val) => val === "" || val === "." || !val.startsWith("/"), {
        message: "subdir must be relative (no leading /)"
      }),
    /**
     * Git pin: a commit SHA (full 40-char or short 7+ hex), a tag name,
     * or a branch name. This is what locks the external ref to a specific
     * revision so it is reproducible. Validated for format only — no clone
     * or network access happens during parsing.
     */
    pin: z
      .string()
      .trim()
      .min(1)
      .refine(isValidGitRef, {
        message:
          "pin must be a valid git ref: full SHA (40 hex), short SHA (7+ hex), tag, or branch name (alphanumeric, /, -, _, .)"
      })
  })
  .strict();

export type ExternalGitSubdirPluginRef = z.infer<typeof ExternalGitSubdirPluginRefSchema>;

// ---------------------------------------------------------------------------
// Parse & validate
// ---------------------------------------------------------------------------

/** Parse and validate raw input into a typed external git-subdir plugin ref. */
export function parseExternalGitSubdirPluginRef(
  raw: unknown
): ExternalGitSubdirPluginRef {
  return ExternalGitSubdirPluginRefSchema.parse(raw);
}

/**
 * Safe variant: returns the parsed result, or `null` when the input does not
 * conform (no throw). Useful for scanning user input / config without crashing.
 */
export function tryParseExternalGitSubdirPluginRef(
  raw: unknown
): ExternalGitSubdirPluginRef | null {
  const result = ExternalGitSubdirPluginRefSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Return `true` when the raw input is a structurally valid external ref.
 * Does NOT clone or fetch — format-only gate.
 */
export function isValidExternalGitSubdirPluginRef(raw: unknown): boolean {
  return ExternalGitSubdirPluginRefSchema.safeParse(raw).success;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * A compact, human-readable label for the ref.
 * Example: `github.com/owner/repo//path/to/plugin@abc1234`
 */
export function formatExternalRef(ref: ExternalGitSubdirPluginRef): string {
  const subdir = ref.subdir ? `//${ref.subdir.replace(/^\//, "")}` : "";
  return `${ref.repo}${subdir}@${ref.pin}`;
}
