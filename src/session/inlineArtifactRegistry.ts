/**
 * InlineArtifactRegistry
 *
 * Pure metadata registry for artifacts (mime + path) produced by named steps.
 * Supports put (upsert by id per step) and list-by-step.
 * No side effects, no I/O, no external dependencies.
 */

export interface InlineArtifact {
  /** Stable identifier for the artifact within its step (or globally). */
  id: string;
  /** MIME type of the artifact (e.g., "text/plain", "image/png"). */
  mime: string;
  /** Filesystem or logical path to the artifact. */
  path: string;
}

/**
 * Registry that associates artifacts with the step that produced them.
 * Duplicate ids within the same step overwrite previous entries (last-write wins).
 */
export class InlineArtifactRegistry {
  private readonly byStep = new Map<string, Map<string, InlineArtifact>>();

  /**
   * Register an artifact for a step. If an artifact with the same id already
   * exists for that step, it is overwritten.
   */
  put(stepId: string, artifact: InlineArtifact): void {
    if (!this.byStep.has(stepId)) {
      this.byStep.set(stepId, new Map<string, InlineArtifact>());
    }
    // Store a shallow copy to keep registry pure (caller cannot mutate stored entry)
    this.byStep.get(stepId)!.set(artifact.id, { ...artifact });
  }

  /**
   * Return all artifacts registered for the given step, in insertion order.
   * Returns a new array each time (defensive copy).
   */
  list(stepId: string): InlineArtifact[] {
    const stepMap = this.byStep.get(stepId);
    if (!stepMap) {
      return [];
    }
    return Array.from(stepMap.values());
  }

  /**
   * Return the set of step ids that have registered at least one artifact.
   * Useful for introspection; not required by plan but keeps surface small and useful.
   */
  listSteps(): string[] {
    return Array.from(this.byStep.keys());
  }
}
