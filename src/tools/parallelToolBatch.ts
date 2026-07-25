export interface ParallelToolBatchOptions<T> {
  /** Returns true only when two calls may safely execute at the same time. */
  readonly independent: (left: T, right: T) => boolean;
}

/**
 * Partition ordered calls into maximal adjacent batches whose members are
 * pairwise independent. Calls that conflict preserve their original order in
 * separate batches, so callers can execute each batch concurrently and await
 * it before moving to the next one.
 */
export function partition<T>(calls: readonly T[], options: ParallelToolBatchOptions<T>): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];

  for (const call of calls) {
    if (current.every((scheduled) => options.independent(scheduled, call))) {
      current.push(call);
      continue;
    }

    batches.push(current);
    current = [call];
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}
