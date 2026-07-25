import { scrubSecretValuesReport } from "../safety/secretSafety.js";

/**
 * JSON-shaped session data accepted by the local share projection.
 *
 * The exporter deliberately does not own a session schema. It is a projection
 * over an existing record, so adding a session field does not require editing
 * this module before it can be exported safely.
 */
export type SessionShareValue =
  | string
  | number
  | boolean
  | null
  | readonly SessionShareValue[]
  | { readonly [key: string]: SessionShareValue | undefined };

export type SessionShareRecord = { readonly [key: string]: SessionShareValue | undefined };

export interface SessionShareExportOptions {
  /**
   * Optional field paths (or public tags) to include. This is a projection
   * allowlist, never a secret-safety bypass: secret-tagged values are omitted
   * and credential-shaped strings are still scrubbed.
   */
  readonly allowlist?: readonly string[];
}

const OMIT = Symbol("session-share-omit");
const SECRET_TAG = /(?:^|[:/_.-])(?:secret|sensitive|credential|private|confidential)(?:$|[:/_.-])/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedAllowlist(options: SessionShareExportOptions): readonly string[] | undefined {
  if (options.allowlist === undefined) {
    return undefined;
  }
  return [...new Set(options.allowlist.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function tagsOf(value: Record<string, unknown>): readonly string[] {
  const tags = value.tags;
  if (Array.isArray(tags)) {
    return tags.filter((tag): tag is string => typeof tag === "string");
  }
  if (typeof value.tag === "string") {
    return [value.tag];
  }
  return [];
}

function isSecretTagged(value: Record<string, unknown>): boolean {
  if (value.secret === true || value.sensitive === true) {
    return true;
  }
  return tagsOf(value).some((tag) => SECRET_TAG.test(tag.trim()));
}

function tagMatchesAllowlist(value: Record<string, unknown>, allowlist: readonly string[] | undefined): boolean {
  if (allowlist === undefined) {
    return false;
  }
  const tags = tagsOf(value);
  return tags.some((tag) => allowlist.includes(tag) || allowlist.includes(tag.trim()));
}

function allowlistIncludesPath(path: string, allowlist: readonly string[] | undefined): boolean {
  return allowlist?.some((entry) => entry === path) ?? false;
}

function allowlistHasDescendant(path: string, allowlist: readonly string[] | undefined): boolean {
  return allowlist?.some((entry) => entry.startsWith(`${path}.`)) ?? false;
}

function pathMatchesAllowlist(path: string, allowlist: readonly string[] | undefined): boolean {
  return allowlist === undefined || allowlistIncludesPath(path, allowlist) || allowlistHasDescendant(path, allowlist);
}

function scrubString(value: string): string {
  return scrubSecretValuesReport(value).text;
}

function project(
  value: unknown,
  path: string,
  allowlist: readonly string[] | undefined,
  inheritedAllow: boolean
): unknown {
  if (typeof value === "string") {
    return allowlist !== undefined && !inheritedAllow && !allowlistIncludesPath(path, allowlist) ? OMIT : scrubString(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return allowlist !== undefined && !inheritedAllow && !allowlistIncludesPath(path, allowlist) ? OMIT : value;
  }
  if (Array.isArray(value)) {
    if (allowlist !== undefined && !inheritedAllow && !allowlistIncludesPath(path, allowlist) && !allowlistHasDescendant(path, allowlist)) {
      return OMIT;
    }
    const projected: unknown[] = [];
    value.forEach((item, index) => {
      const child = project(item, `${path}.${index}`, allowlist, inheritedAllow);
      if (child !== OMIT) {
        projected.push(child);
      }
    });
    return projected;
  }
  if (!isRecord(value)) {
    return OMIT;
  }
  if (isSecretTagged(value)) {
    return OMIT;
  }
  const selected =
    inheritedAllow ||
    allowlist === undefined ||
    path.length === 0 ||
    pathMatchesAllowlist(path, allowlist) ||
    tagMatchesAllowlist(value, allowlist);
  if (!selected) {
    return OMIT;
  }

  const output: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (childValue === undefined) {
      continue;
    }
    const childPath = path.length > 0 ? `${path}.${key}` : key;
    const child = project(childValue, childPath, allowlist, allowlist === undefined || (path.length > 0 && selected));
    if (child !== OMIT) {
      // Scrub keys too: a malformed record must not smuggle a credential in a
      // property name, even though normal session schemas use fixed metadata keys.
      output[scrubString(key)] = child;
    }
  }
  return output;
}

/**
 * Produce a local, share-ready projection of a session record.
 *
 * Secret-tagged objects are removed before projection. All remaining strings,
 * including untagged credential-shaped values and registered credential values,
 * pass through GuruHarness's canonical scrubber. The optional allowlist can
 * reduce the projection or select a public tag, but can never restore a secret.
 */
export function exportSession<T extends SessionShareRecord>(
  record: T,
  options: SessionShareExportOptions = {}
): Partial<T> {
  if (!isRecord(record)) {
    throw new TypeError("session share export requires a record object");
  }
  const allowlist = normalizedAllowlist(options);
  const projected = project(record, "", allowlist, false);
  return (projected === OMIT ? {} : projected) as Partial<T>;
}
