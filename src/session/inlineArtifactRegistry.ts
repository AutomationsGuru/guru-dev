/**
 * InlineArtifactRegistry — pure metadata registry for artifacts produced by
 * steps during a session. Each entry records the artifact's MIME type and
 * filesystem path plus an optional label, keyed by step id.
 *
 * This is a metadata-only surface; it never creates, reads, moves, overwrites,
 * or deletes the actual artifact files.  Callers own the files; the registry
 * only tracks what was produced and where.
 *
 * SCOPE: F474 inline-artifact-registry — put/list by step, duplicate-id-overwrite.
 */

/** A single artifact entry registered against a step. */
export interface InlineArtifact {
  /** Unique identifier within the owning step (duplicates overwrite). */
  readonly id: string;
  /** MIME type of the artifact (e.g. "text/markdown", "image/png"). */
  readonly mime: string;
  /** Absolute or repo-relative filesystem path to the artifact file. */
  readonly path: string;
  /** Optional human-readable label. */
  readonly label?: string;
}

/**
 * Per-step, in-memory artifact registry.  Each step has its own list;
 * cross-step isolation is guaranteed — a `list("a")` never sees step b's
 * artifacts.
 */
export class InlineArtifactRegistry {
  private readonly store = new Map<string, InlineArtifact[]>();

  /**
   * Register (or overwrite) an artifact for `stepId`.
   * If an artifact with the same `id` already exists under the same step it is
   * silently replaced — this is the "duplicate id overwrite" contract.
   */
  put(stepId: string, artifact: InlineArtifact): void {
    const entries = this.store.get(stepId);
    if (!entries) {
      this.store.set(stepId, [artifact]);
      return;
    }
    const idx = entries.findIndex((a) => a.id === artifact.id);
    if (idx >= 0) {
      entries[idx] = artifact; // overwrite
    } else {
      entries.push(artifact);
    }
  }

  /** Return a frozen snapshot of every artifact registered for `stepId`. */
  list(stepId: string): readonly InlineArtifact[] {
    const entries = this.store.get(stepId);
    if (!entries || entries.length === 0) {
      return [];
    }
    return Object.freeze([...entries]);
  }

  /** Drop every artifact for `stepId`.  No-op when the step has no entries. */
  clear(stepId: string): void {
    this.store.delete(stepId);
  }

  /**
   * Remove a single artifact by step + artifact id.
   * Returns `true` when the artifact was found and removed, `false` when no
   * such artifact existed.
   */
  remove(stepId: string, artifactId: string): boolean {
    const entries = this.store.get(stepId);
    if (!entries) return false;
    const idx = entries.findIndex((a) => a.id === artifactId);
    if (idx < 0) return false;
    entries.splice(idx, 1);
    if (entries.length === 0) {
      this.store.delete(stepId);
    }
    return true;
  }
}
