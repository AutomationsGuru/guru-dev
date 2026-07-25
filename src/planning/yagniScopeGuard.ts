/**
 * YAGNI Scope Guard
 *
 * Rejects plan tasks whose files are outside declared owned paths.
 * Enforces YAGNI principle: only explicitly owned paths may be modified.
 *
 * @module src/planning/yagniScopeGuard
 */

/**
 * Check if a path is within an owned path prefix.
 *
 * @param path - The path to check
 * @param owned - The owned path prefix
 * @returns true if path starts with owned (with proper boundary)
 */
function isPathWithinOwned(path: string, owned: string): boolean {
  // Normalize paths: remove leading/trailing slashes for comparison
  const normalizedPath = path.replace(/^\/+|\/+$/g, '');
  const normalizedOwned = owned.replace(/^\/+|\/+$/g, '');

  // Exact match
  if (normalizedPath === normalizedOwned) {
    return true;
  }

  // Path must start with owned followed by a path separator or be a subdirectory
  return normalizedPath.startsWith(normalizedOwned + '/');
}

/**
 * Assert that all paths are within the declared owned paths.
 *
 * Throws an error if any path is outside the owned set.
 * This is the core YAGNI enforcement: plans may only touch explicitly owned files.
 *
 * @param paths - Array of paths to validate
 * @param owned - Array of owned path prefixes
 * @throws {Error} If any path is outside owned scope
 */
export function assertInScope(paths: string[], owned: string[]): void {
  if (!Array.isArray(paths)) {
    throw new Error('assertInScope: paths must be an array');
  }
  if (!Array.isArray(owned)) {
    throw new Error('assertInScope: owned must be an array');
  }

  const violations: string[] = [];

  for (const path of paths) {
    if (typeof path !== 'string') {
      throw new Error(`assertInScope: invalid path type: ${typeof path}`);
    }

    // Check if path is within any owned prefix
    const isOwned = owned.some(o => isPathWithinOwned(path, o));

    if (!isOwned) {
      violations.push(path);
    }
  }

  if (violations.length > 0) {
    const ownedList = owned.length > 0 ? owned.join(', ') : '(none)';
    throw new Error(
      `YAGNI scope violation: paths outside owned scope: [${violations.join(', ')}]. ` +
      `Owned paths: [${ownedList}]. ` +
      `Only explicitly owned paths may be modified.`
    );
  }
}

/**
 * Enforce scope guard - returns boolean instead of throwing.
 * Useful for conditional logic without exception handling.
 *
 * @param paths - Array of paths to validate
 * @param owned - Array of owned path prefixes
 * @returns true if all paths are in scope, false otherwise
 */
export function enforceScope(paths: string[], owned: string[]): boolean {
  try {
    assertInScope(paths, owned);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of out-of-scope paths without throwing.
 *
 * @param paths - Array of paths to check
 * @param owned - Array of owned path prefixes
 * @returns Array of paths that are outside owned scope
 */
export function getOutOfScopePaths(paths: string[], owned: string[]): string[] {
  if (!Array.isArray(paths) || !Array.isArray(owned)) {
    return [];
  }

  return paths.filter(path => {
    if (typeof path !== 'string') return true;
    return !owned.some(o => isPathWithinOwned(path, o));
  });
}
