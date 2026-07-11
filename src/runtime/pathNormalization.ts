const PATH_FIELD_NAMES = new Set(["configPath", "cwd", "repoRoot", "rootPath", "targetPath"]);
const MSYS_ABSOLUTE_PATH_PATTERN = /^\/([A-Za-z])(?:\/(.*))?$/u;

export function normalizeMsysPath(value: string): string {
  const match = MSYS_ABSOLUTE_PATH_PATTERN.exec(value);

  if (!match) {
    return value;
  }

  const driveLetter = match[1] ?? "";
  const rest = match[2] ?? "";

  return rest.length > 0 ? `${driveLetter.toUpperCase()}:/${rest}` : `${driveLetter.toUpperCase()}:/`;
}

export function normalizeKnownPathFields<T>(value: T): T {
  return normalizeKnownPathFieldsForKey(value, undefined) as T;
}

function normalizeKnownPathFieldsForKey(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") {
    return key && PATH_FIELD_NAMES.has(key) ? normalizeMsysPath(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeKnownPathFieldsForKey(item, key));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, normalizeKnownPathFieldsForKey(entryValue, entryKey)]));
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
