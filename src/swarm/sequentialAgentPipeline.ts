/**
 * Sequential Agent Pipeline — Pure Deterministic Composition
 *
 * Composes an ordered array of pure transform functions into a single
 * deterministic pipeline. Each transform receives the output of the previous
 * transform as its input. Order is strictly preserved.
 *
 * Per PLAN (IDEA-F520-SEQ-01): primary public API is runSequential.
 * sequentialAgentPipeline is exported as an exact compatibility alias.
 *
 * Constraints (enforced by design):
 * - No model calls, providers, tools, networks, or file I/O
 * - No retries, fanout, background work, or runtime registration
 * - No framework or external dependencies
 * - Pure functions only — deterministic, side-effect free
 *
 * @template T - The type flowing through the pipeline
 * @param transforms - Ordered array of pure transform functions
 * @returns A composed function accepting initial input and returning final output
 */
export function runSequential<T>(
  transforms: ReadonlyArray<(input: T) => T>
): (initialInput: T) => T {
  return (initialInput: T): T => {
    return transforms.reduce((current, transform) => transform(current), initialInput);
  };
}

/**
 * Exact compatibility alias for runSequential per PLAN alignment.
 */
export { runSequential as sequentialAgentPipeline };
