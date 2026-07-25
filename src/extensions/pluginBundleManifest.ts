/**
 * Plugin bundle manifest (IDEA-F394-PLUG-01).
 *
 * A plugin bundle is a typed, versioned description of what a plugin contributes
 * to GuruHarness through the one frozen extension seam (Vision §2): a name, a
 * semver `version`, a `skills[]` list, and a `hooks[]` list. The manifest is the
 * contract a bundle declares before any of its code is loaded; the host checks it
 * before activation so a malformed or incompatible bundle is rejected at the door
 * rather than poisoning the kernel after partial registration.
 *
 * Version discipline is a hard edge (Vision review checklist: "version discipline").
 * `version` MUST be a strict semver (`MAJOR.MINOR.PATCH`, optional `-prerelease`,
 * optional `+build`). `satisfies(manifest, range)` performs the semver check against
 * a required range of the same grammar, so the host can refuse a bundle the running
 * harness is not prepared to load.
 *
 * No third-party semver dependency is introduced; the small parser below covers the
 * subset the manifest contract needs (strict versions + simple `^`/`~`/`=`/exact
 * comparators and `||` ranges). Hard limits are never weakened.
 */

/**
 * Strict semver: MAJOR.MINOR.PATCH with optional dotted prerelease and build.
 * No leading "v", no leading zeros on numeric components, no "x"/"*" wildcards —
 * a manifest version is an exact published version, never a range.
 */
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Prerelease precedence: numeric < alphas (semver §11). 1.0.0-alpha < 1.0.0. */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  // No prerelease has HIGHER precedence than any prerelease.
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;

  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1; // shorter prerelease set has lower precedence
    if (xb === undefined) return 1;
    const na = /^[0-9]+$/.test(xa);
    const nb = /^[0-9]+$/.test(xb);
    if (na && nb) {
      const diff = Number(xa) - Number(xb);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (na) {
      return -1; // numeric identifiers always lower than alphanumeric
    } else if (nb) {
      return 1;
    } else {
      const cmp = xa < xb ? -1 : xa > xb ? 1 : 0;
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/** Parsed strict semver (no build metadata — it never affects precedence). */
interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | undefined;
}

function parseStrict(version: string): SemverParts | null {
  const match = STRICT_SEMVER.exec(version.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * A range comparator: `^`, `~`, `=`, or exact. `*` (any) is intentionally NOT
 * accepted — a manifest declares a real version. Ranges here describe what a host
 * is willing to load, never what a bundle may publish as.
 */
type Operator = "^" | "~" | "=" | "exact";

interface Comparator {
  readonly operator: Operator;
  readonly parts: SemverParts;
}

const RANGE_RE = /^([\^~=]?)\s*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseComparator(term: string): Comparator | null {
  const match = RANGE_RE.exec(term.trim());
  if (!match) return null;
  const [, opRaw, major, minor, patch, prerelease] = match;
  const operator: Operator = opRaw === "^" ? "^" : opRaw === "~" ? "~" : opRaw === "=" ? "=" : "exact";
  return {
    operator,
    parts: { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease }
  };
}

function satisfiesComparator(version: SemverParts, cmp: Comparator): boolean {
  const c = compareSemver(version, cmp.parts);
  switch (cmp.operator) {
    case "exact":
    case "=":
      return c === 0;
    case "~": {
      // ~>={major.minor.patch} and <{major}.(minor+1).0; major-minor locked.
      if (cmp.parts.prerelease !== undefined) {
        // ~1.2.3-beta only matches within the prerelease series of the same patch.
        return c === 0 && version.prerelease !== undefined;
      }
      if (version.major !== cmp.parts.major || version.minor !== cmp.parts.minor) return false;
      if (version.prerelease !== undefined && c !== 0) return false; // prerelease of a different patch excluded
      return compareSemver(version, { major: cmp.parts.major, minor: cmp.parts.minor, patch: 0, prerelease: undefined }) >= 0;
    }
    case "^": {
      // Compatible-with: same major (or, for 0.x / 0.0.x, narrower lock per semver convention).
      if (cmp.parts.major !== 0) {
        return version.major === cmp.parts.major && c >= 0;
      }
      if (cmp.parts.minor !== 0) {
        return version.major === 0 && version.minor === cmp.parts.minor && c >= 0;
      }
      return version.major === 0 && version.minor === 0 && version.patch === cmp.parts.patch && c >= 0;
    }
    default:
      return false;
  }
}

/**
 * Check a concrete (strict) version against a range string. A range is one or more
 * comparators joined by whitespace (AND), optionally separated by `||` (OR).
 * Throws if the version or range is malformed — a bad range is a programmer error,
 * not a runtime "no match."
 */
export function satisfies(version: string, range: string): boolean {
  const parts = parseStrict(version);
  if (!parts) {
    throw new PluginBundleManifestError(`Invalid manifest version "${version}": expected strict semver MAJOR.MINOR.PATCH.`);
  }
  const trimmed = range.trim();
  if (trimmed.length === 0) {
    throw new PluginBundleManifestError("Invalid version range: expected at least one comparator.");
  }
  const orGroups = trimmed.split("||").map((g) => g.trim()).filter((g) => g.length > 0);
  if (orGroups.length === 0) {
    throw new PluginBundleManifestError("Invalid version range: expected at least one comparator.");
  }
  for (const group of orGroups) {
    const terms = group.split(/\s+/).filter((t) => t.length > 0);
    const comparators: Comparator[] = [];
    for (const term of terms) {
      const cmp = parseComparator(term);
      if (!cmp) {
        throw new PluginBundleManifestError(`Invalid version range comparator "${term}".`);
      }
      comparators.push(cmp);
    }
    if (comparators.every((cmp) => satisfiesComparator(parts, cmp))) {
      return true;
    }
  }
  return false;
}

/** A skill contributed by a plugin bundle — referenced by id; resolution is the host's job. */
export interface PluginBundleSkillEntry {
  readonly id: string;
}

/** A hook contributed by a plugin bundle — a named lifecycle hook (e.g. "tool-result"). */
export interface PluginBundleHookEntry {
  readonly id: string;
}

/** A parsed, validated plugin bundle manifest. */
export interface PluginBundleManifest {
  readonly name: string;
  readonly version: string;
  readonly skills: readonly PluginBundleSkillEntry[];
  readonly hooks: readonly PluginBundleHookEntry[];
  /** Optional engine range this bundle requires of the host (semver grammar). */
  readonly engines?: { readonly guru?: string };
}

export class PluginBundleManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginBundleManifestError";
  }
}

const NAME_RE = /^@(?:[A-Za-z0-9][\w.-]*)\/[A-Za-z0-9][\w.-]*$|^[A-Za-z0-9][\w.-]*$/;
const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PluginBundleManifestError(`Manifest field "${field}" must be a string.`);
  }
  return value;
}

function asEntryList(value: unknown, field: string): readonly PluginBundleSkillEntry[] | readonly PluginBundleHookEntry[] {
  if (!Array.isArray(value)) {
    throw new PluginBundleManifestError(`Manifest field "${field}" must be an array.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new PluginBundleManifestError(`Manifest field "${field}[${index}]" must be an object with an "id".`);
    }
    const id = asString((item as Record<string, unknown>).id, `${field}[${index}].id`).trim();
    if (!ENTRY_ID_RE.exec(id)) {
      throw new PluginBundleManifestError(`Manifest field "${field}[${index}].id" is not a valid entry id.`);
    }
    return { id };
  });
}

/**
 * Parse and validate a plugin bundle manifest from a parsed JSON value (or JSON string).
 *
 * Accepts either an already-parsed object or a raw JSON string; the caller normally
 * JSON.parses the bundle file first, but accepting a string keeps the seam cheap to
 * use from the loader. Throws `PluginBundleManifestError` for any malformed input —
 * including a bad version, which is the plan's required failure case.
 */
export function parseManifest(input: unknown): PluginBundleManifest {
  let source: unknown = input;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      throw new PluginBundleManifestError("Manifest input is not valid JSON.");
    }
  }

  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new PluginBundleManifestError("Manifest must be a JSON object.");
  }

  const record = source as Record<string, unknown>;

  const name = asString(record.name, "name").trim();
  if (!NAME_RE.exec(name)) {
    throw new PluginBundleManifestError('Manifest field "name" is not a valid bundle name.');
  }

  const version = asString(record.version, "version").trim();
  if (!parseStrict(version)) {
    throw new PluginBundleManifestError(`Manifest field "version" is not strict semver: "${version}".`);
  }

  const skills = asEntryList(record.skills, "skills");
  const hooks = asEntryList(record.hooks, "hooks");

  let engines: { readonly guru?: string } | undefined;
  if (record.engines !== undefined) {
    if (record.engines === null || typeof record.engines !== "object" || Array.isArray(record.engines)) {
      throw new PluginBundleManifestError('Manifest field "engines" must be an object.');
    }
    const enginesRecord = record.engines as Record<string, unknown>;
    if (enginesRecord.guru !== undefined) {
      const guru = asString(enginesRecord.guru, "engines.guru").trim();
      // Validate the range grammar eagerly: a bad required range is a manifest bug.
      satisfies(version, guru);
      engines = { guru };
    }
  }

  return {
    name,
    version,
    skills: skills as readonly PluginBundleSkillEntry[],
    hooks: hooks as readonly PluginBundleHookEntry[],
    ...(engines ? { engines } : {})
  };
}
