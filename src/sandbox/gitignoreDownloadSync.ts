/**
 * Returns workspace-relative files that can be copied back to the host.
 * Patterns use the small gitignore-style glob subset needed by sync callers.
 */
export function listSyncable(paths: readonly string[], ignorePatterns: readonly string[]): string[] {
  return paths.filter((path) => !isIgnored(normalizePath(path), ignorePatterns));
}

function isIgnored(path: string, patterns: readonly string[]): boolean {
  let ignored = false;

  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const negated = trimmed.startsWith("!");
    const pattern = negated ? trimmed.slice(1) : trimmed;
    if (pattern.length > 0 && patternMatches(path, pattern)) {
      ignored = !negated;
    }
  }

  return ignored;
}

function patternMatches(path: string, pattern: string): boolean {
  const normalized = normalizePath(pattern);
  const directoryPattern = normalized.endsWith("/");
  const body = directoryPattern ? normalized.slice(0, -1) : normalized;
  const anchored = body.startsWith("/");
  const glob = anchored ? body.slice(1) : body;
  const expression = globToRegExp(glob);

  if (directoryPattern) {
    return path.split("/").some((_, index, segments) => expression.test(segments.slice(0, index + 1).join("/")));
  }

  if (anchored || glob.includes("/")) {
    return expression.test(path);
  }

  return path.split("/").some((segment) => expression.test(segment));
}

function globToRegExp(pattern: string): RegExp {
  let expression = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }

  return new RegExp(`${expression}$`, "u");
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}
