/**
 * Sensitive path segments that must never be treated as ordinary workspace paths.
 * This check is deliberately independent of mandate grants and YOLO mode.
 */
const PROTECTED_SEGMENTS: ReadonlySet<string> = new Set([".ssh"]);

/**
 * Returns true when a lexical path resolves within a protected path segment.
 * Both POSIX and Windows separators are accepted so policy remains host-neutral.
 */
export function isProtected(path: string): boolean {
  const segments: string[] = [];

  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()));
}
