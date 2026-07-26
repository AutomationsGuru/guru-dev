import type { DetachableSessionMarker } from './types';

/**
 * Creates a new detachable session marker for the given session and worktree.
 * This enables the session to be detached and later reattached to the same context.
 */
export function createDetachableMarker(
  sessionId: string,
  worktreePath: string
): DetachableSessionMarker {
  return {
    sessionId,
    markerId: `detachable-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    attachedAt: new Date(),
    worktreePath,
  };
}

/**
 * Marks the session as detached, preserving the marker for future reattachment.
 */
export function detachSessionMarker(
  marker: DetachableSessionMarker
): DetachableSessionMarker {
  return {
    ...marker,
    detachedAt: new Date(),
  };
}

/**
 * Reattaches a previously detached session marker, updating the attach timestamp.
 * Allows seamless continuation in the original worktree context.
 */
export function attachSessionMarker(
  marker: DetachableSessionMarker
): DetachableSessionMarker {
  return {
    ...marker,
    detachedAt: undefined,
    attachedAt: new Date(),
  };
}

/**
 * Validates that a marker is still attachable (not expired or invalid).
 * Basic check for vision-aligned durability.
 */
export function isMarkerAttachable(marker: DetachableSessionMarker): boolean {
  if (!marker.sessionId || !marker.markerId || !marker.worktreePath) {
    return false;
  }
  // Future: add TTL or persistence checks here
  return true;
}