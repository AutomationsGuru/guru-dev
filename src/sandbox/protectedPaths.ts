/**
 * Protected-path denylist (F102, IDEA-F102-PROTECTED-PATHS-01).
 *
 * Pure, side-effect-free path policy for the workspace-write sandbox. Even when
 * the sandbox allows workspace writes as a whole, writes (and destructive
 * shell) targeting protected prefixes are NOT auto-allowed under YOLO.
 *
 * Three return values from {@link checkWrite}:
 *   - "allow"           — outside every protected prefix; safe under default YOLO.
 *   - "require-elevate" — matched a protected prefix; caller MUST require an
 *                         explicit elevate class before proceeding. This is the
 *                         safer / clearer of the two negative signals and is
 *                         what the plan enumerates first; higher layers may
 *                         treat an elevate refusal as a deny.
 *   - "deny"            — reserved for hard blocks (currently unused at this
 *                         layer; surfaced so callers can rely on the enum).
 *
 * All comparisons are segment-aware (so `.git` never matches `myrepo.git/`)
 * and Windows-backslash-safe. There is intentionally no filesystem IO in the
 * hot path — tests inject `opts.homeDir` and `opts.extraPrefixes` directly.
 */

import { isAbsolute, relative, sep, normalize as normalizePath } from "node:path";

/**
 * Decision returned by {@link checkWrite}. Kept as a string-literal union so
 * callers can `switch` exhaustively without importing a TS enum.
 */
export type WriteDecision = "allow" | "deny" | "require-elevate";

/**
 * Options accepted by {@link isProtected} and {@link checkWrite}.
 *
 * - `extraPrefixes` — additional slash-normalized relative prefixes to merge
 *   with the defaults. Trailing slashes are tolerated and stripped.
 * - `homeDir` — absolute path of the operator's home directory. When supplied,
 *   the home-profile prefixes (`~/.guruharness/vault/`, `~/.guruharness/secrets/`)
 *   are resolved to absolute form and matched against absolute target paths
 *   that may live OUTSIDE the workspace root.
 */
export interface ProtectedPathOptions {
  readonly extraPrefixes?: readonly string[];
  readonly homeDir?: string;
}

const HOME_PROFILE_VAULT_SUFFIX = "/.guruharness/vault/";
const HOME_PROFILE_SECRETS_SUFFIX = "/.guruharness/secrets/";

/**
 * The default relative protected prefixes. These are slash-normalized, do NOT
 * start with a leading `/`, and do NOT include a leading `./`. They are
 * matched against `path.relative(workspaceRoot, absPath)` segments so that a
 * top-level `.git/` directory is matched, but a nested `vendor/.git/` is not
 * (only the literal top-level segment is in defaults; nested vendor `.git`
 * dirs are not, by design — see tests).
 */
const DEFAULT_RELATIVE_PREFIXES: readonly string[] = Object.freeze([
  ".git/",
  ".guru/"
]);

/**
 * Returns the default set of protected path prefixes (relative,
 * slash-normalized). Includes:
 *   - `.git/`                 — repo git internals
 *   - `.guru/`                — project agent config dir
 *   - `~/.guruharness/vault/` — operator credential vault (home-profile)
 *   - `~/.guruharness/secrets/` — operator secret store (home-profile)
 *
 * The home-profile entries are returned in their `~`-relative slash form so
 * callers can present them to the user without leaking absolute paths. The
 * matcher resolves them to absolute paths against `opts.homeDir` internally.
 */
export function defaultProtectedPrefixes(): readonly string[] {
  return [
    ...DEFAULT_RELATIVE_PREFIXES,
    `~${HOME_PROFILE_VAULT_SUFFIX}`,
    `~${HOME_PROFILE_SECRETS_SUFFIX}`
  ];
}

/**
 * True iff `absPath` falls under any default or extra protected prefix.
 *
 * Pure. Does NOT touch the filesystem. When `workspaceRoot` is omitted (or
 * empty), only the absolute home-profile prefixes can match — relative
 * prefixes (like `.git/`) need a workspace root to anchor against.
 */
export function isProtected(
  absPath: string,
  workspaceRoot?: string,
  opts: ProtectedPathOptions = {}
): boolean {
  const normalizedTarget = normalizeForCompare(absPath);
  if (normalizedTarget.length === 0) {
    return false;
  }

  const effectiveExtras = normalizeExtraPrefixes(opts.extraPrefixes);

  // 1) Absolute home-profile secret prefixes (matched via opts.homeDir).
  if (opts.homeDir && opts.homeDir.length > 0) {
    const homeVault = stripTrailingSlash(`${normalizeForCompare(opts.homeDir)}${HOME_PROFILE_VAULT_SUFFIX}`);
    const homeSecrets = stripTrailingSlash(`${normalizeForCompare(opts.homeDir)}${HOME_PROFILE_SECRETS_SUFFIX}`);
    if (
      isUnderAbsolutePrefix(normalizedTarget, homeVault) ||
      isUnderAbsolutePrefix(normalizedTarget, homeSecrets)
    ) {
      return true;
    }
  }

  // 2) Relative prefixes anchored at the workspace root.
  if (workspaceRoot && workspaceRoot.length > 0 && isAbsolute(workspaceRoot)) {
    const normalizedRoot = stripTrailingSlash(normalizeForCompare(workspaceRoot));
    const relativeToRoot = normalizeForCompare(relative(normalizedRoot, normalizedTarget));

    if (!relativeToRoot.startsWith("..") && !isAbsolute(relativeToRoot)) {
      for (const prefix of DEFAULT_RELATIVE_PREFIXES) {
        if (matchesRelativePrefix(relativeToRoot, prefix)) {
          return true;
        }
      }
      for (const prefix of effectiveExtras) {
        if (matchesRelativePrefix(relativeToRoot, prefix)) {
          return true;
        }
      }
    }
  }

  // 3) Caller-supplied extras may also include absolute prefixes (e.g. test
  //    cases pass `/home/op/.guruharness/vault/` directly). Try them as
  //    absolute anchors too.
  for (const prefix of effectiveExtras) {
    if (isAbsolute(prefix)) {
      const normalizedPrefix = stripTrailingSlash(normalizeForCompare(prefix));
      if (isUnderAbsolutePrefix(normalizedTarget, normalizedPrefix)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns the write decision for `absPath` under the protected-path policy.
 * Same signature family as {@link isProtected}. Pure.
 */
export function checkWrite(
  absPath: string,
  workspaceRoot?: string,
  opts: ProtectedPathOptions = {}
): WriteDecision {
  if (isProtected(absPath, workspaceRoot, opts)) {
    return "require-elevate";
  }
  return "allow";
}

/**
 * Slash-normalize + strip any platform separators the caller used. Backslashes
 * become forward slashes so Windows-style paths compare equal to POSIX-style.
 * Trailing slashes are removed so prefix equality is anchor-stable.
 *
 * A leading backslash (e.g. `\repo\.git\config`) is treated as a Windows
 * root-anchored path and re-anchored to POSIX `/` so it survives
 * `path.relative` under workspace-root matching on POSIX hosts.
 */
function normalizeForCompare(value: string): string {
  if (value.length === 0) {
    return "";
  }
  const hadLeadingBackslash = value.startsWith("\\");
  const slashed = value.replace(/\\/gu, "/");
  const normalized = normalizePath(slashed);
  const forward = normalized.replace(/\\/gu, "/");
  if (hadLeadingBackslash && forward.startsWith("/") === false) {
    return `/${forward}`;
  }
  return forward;
}

function stripTrailingSlash(value: string): string {
  if (value === "/") {
    return value;
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeExtraPrefixes(extras: readonly string[] | undefined): readonly string[] {
  if (!extras || extras.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const raw of extras) {
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }
    const normalized = normalizeForCompare(raw);
    if (normalized.length === 0) {
      continue;
    }
    out.push(stripTrailingSlash(normalized));
  }
  return out;
}

/**
 * Segment-aware match of `relativePath` against `prefix`. The first segment of
 * `prefix` must equal the first segment of `relativePath` exactly (so `.git`
 * does NOT match `myrepo.git/...`). Multi-segment prefixes must align on every
 * segment.
 */
function matchesRelativePrefix(relativePath: string, prefix: string): boolean {
  const targetSegments = splitSegments(relativePath);
  const prefixSegments = splitSegments(prefix);
  if (prefixSegments.length === 0 || targetSegments.length < prefixSegments.length) {
    return false;
  }
  for (let i = 0; i < prefixSegments.length; i += 1) {
    if (targetSegments[i] !== prefixSegments[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Absolute-prefix match: true iff `target` is `prefix` itself, or starts with
 * `prefix + '/'`. Both arguments are expected to be slash-normalized and
 * have no trailing slash (caller's responsibility).
 */
function isUnderAbsolutePrefix(target: string, prefix: string): boolean {
  if (target === prefix) {
    return true;
  }
  return target.startsWith(`${prefix}/`);
}

function splitSegments(value: string): readonly string[] {
  // `sep` is `\\` on Windows and `/` elsewhere; we've already normalized to '/'.
  return value.split("/").filter((segment) => segment.length > 0);
}
