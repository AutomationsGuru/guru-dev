import * as path from "path";

/**
 * Compiles a gitignore glob-style pattern string into a RegExp body.
 */
function compilePattern(pattern: string): string {
  let regexStr = "";
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at] as string;
    if (char === "*") {
      if (pattern[at + 1] === "*") {
        const hasSlashBefore = at > 0 && pattern[at - 1] === "/";
        const hasSlashAfter = at + 2 < pattern.length && pattern[at + 2] === "/";

        if (hasSlashBefore && hasSlashAfter) {
          // e.g., 'foo/**/bar' -> 'foo/(?:.*/)?bar'
          regexStr += "(?:.*/)?";
          at += 2; // skip second '*' and the '/'
        } else if (hasSlashAfter) {
          // e.g., '**/bar' -> '(?:.*/)?bar'
          regexStr += "(?:.*/)?";
          at += 2; // skip second '*' and the '/'
        } else if (hasSlashBefore) {
          // e.g., 'foo/**' -> 'foo/.*'
          regexStr += ".*";
          at += 1; // skip second '*'
        } else {
          // standalone '**' -> '.*'
          regexStr += ".*";
          at += 1; // skip second '*'
        }
      } else {
        // single '*' -> matches non-slash characters
        regexStr += "[^/]*";
      }
    } else if (char === "?") {
      regexStr += "[^/]";
    } else if (char === "/") {
      regexStr += "/";
    } else {
      // Escape all RegExp special characters
      regexStr += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return regexStr;
}

export interface IgnorePattern {
  regex: RegExp;
  isNegated: boolean;
  hasTrailingSlash: boolean;
  raw: string;
}

/**
 * A highly robust, self-contained gitignore-style pattern matcher.
 * Supports standard gitignore basics: comments, empty lines,
 * directory-only matching, and root-relative anchoring.
 */
export class WorkspaceIgnorePatterns {
  private patterns: IgnorePattern[] = [];

  constructor(lines: string[]) {
    for (const rawLine of lines) {
      // Trim leading/trailing whitespace
      const line = rawLine.trim();

      // Ignore empty lines and comments
      if (line === "" || line.startsWith("#")) {
        continue;
      }

      let patternStr = line;
      let isNegated = false;

      // Handle negation
      if (patternStr.startsWith("!")) {
        isNegated = true;
        patternStr = patternStr.slice(1).trim();
      }

      let isAnchored = false;
      let hasTrailingSlash = false;

      // Handle leading slash anchoring
      if (patternStr.startsWith("/")) {
        isAnchored = true;
        patternStr = patternStr.slice(1);
      }

      // Handle trailing slash (directory matching only)
      if (patternStr.endsWith("/")) {
        hasTrailingSlash = true;
        patternStr = patternStr.slice(0, -1);
      }

      // Handle explicit '**/', which means match at any level (unanchored)
      if (patternStr.startsWith("**/")) {
        isAnchored = false;
        patternStr = patternStr.slice(3);
      } else if (patternStr.includes("/")) {
        // If it contains an internal slash, it is anchored to the root
        isAnchored = true;
      }

      const compiled = compilePattern(patternStr);
      let regexStr = "";

      if (isAnchored) {
        regexStr = `^${compiled}$`;
      } else {
        regexStr = `^(?:.*/)?${compiled}$`;
      }

      this.patterns.push({
        regex: new RegExp(regexStr, "u"),
        isNegated,
        hasTrailingSlash,
        raw: line,
      });
    }
  }

  /**
   * Helper static builder.
   */
  static fromLines(lines: string[]): WorkspaceIgnorePatterns {
    return new WorkspaceIgnorePatterns(lines);
  }

  /**
   * Returns true if the given workspace-relative path matches the ignore patterns.
   * Path evaluation handles directory ancestry matching in accordance with gitignore rules:
   * if a parent directory of a path is ignored, all of its contents are ignored and cannot
   * be re-included.
   */
  isIgnored(relativePath: string): boolean {
    if (this.patterns.length === 0) {
      return false;
    }

    // Normalize path slashes to forward-slashes
    let normalized = relativePath.replace(/\\/g, "/");

    // Remove leading './' or '/'
    if (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
    }
    if (normalized.startsWith("/")) {
      normalized = normalized.slice(1);
    }

    // Remove trailing slash
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    if (normalized === "") {
      return false;
    }

    const segments = normalized.split("/");
    let currentSubpath = "";

    // Evaluate subpaths hierarchically from top to bottom
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i] as string;
      currentSubpath = currentSubpath ? `${currentSubpath}/${segment}` : segment;

      const isLast = i === segments.length - 1;
      const isDirectory = !isLast;

      let isSubpathIgnored = false;

      for (const pattern of this.patterns) {
        // In gitignore, directory-only patterns (with trailing slash) can only match directories.
        // A segment is a directory if it's not the final segment (isLast is false),
        // OR if we are evaluating the final segment of a path representing a directory.
        // For robustness, since isIgnored can be called on folders directly (e.g. "node_modules"),
        // we treat the final segment as potentially a directory when matching directory-only patterns.
        const isDirMatchEligible = isDirectory || pattern.hasTrailingSlash;

        // Directory-only pattern check
        if (pattern.hasTrailingSlash && !isDirMatchEligible) {
          continue;
        }

        if (pattern.regex.test(currentSubpath)) {
          isSubpathIgnored = !pattern.isNegated;
        }
      }

      // If an ancestor directory is ignored, stop immediately and return true (ignored)
      // Since we iterate from top to bottom, this correctly implements the rule that
      // files under an ignored directory cannot be re-included.
      if (isSubpathIgnored) {
        return true;
      }
    }

    return false;
  }
}
