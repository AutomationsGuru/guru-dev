export interface WorkflowStep {
  readonly id: string;
}

/** Combines ordered workflow steps only when every step ID is unique. */
export function compose<T extends WorkflowStep>(first: readonly T[], second: readonly T[]): T[] {
  const ids = new Set<string>();

  for (const step of [...first, ...second]) {
    if (ids.has(step.id)) {
      throw new Error(`Duplicate workflow step id: ${step.id}`);
    }
    ids.add(step.id);
  }

  return [...first, ...second];
}
