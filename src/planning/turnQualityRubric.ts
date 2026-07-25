/**
 * Turn quality rubric (IDEA-F209-TURN-RUBRIC-01, R-DA-RUBRIC).
 *
 * Sticky criteria that grade every turn, plus a next-turn-only one-shot that is
 * cleared after it is consumed. Sticky rubrics persist across turns; a one-shot
 * takes precedence for exactly the next consumed turn, then the sticky rubric
 * (if any) applies again.
 *
 * Composes with F208 goals (the objective) and F160 gates (hard-limit
 * enforcement); a rubric is acceptance criteria, never an approval bypass.
 */

export interface TurnQualityRubric {
  /** Set criteria applied to every turn until replaced or cleared. */
  setSticky(criteria: readonly string[]): void;
  /** Set criteria applied to the next consumed turn only, then discarded. */
  setNext(criteria: readonly string[]): void;
  /**
   * Return the effective criteria for the current turn. A pending one-shot is
   * consumed (cleared) by this call; sticky criteria persist.
   * Returns `undefined` when no rubric is active.
   */
  consumeForTurn(): string[] | undefined;
  /**
   * Return the effective criteria without consuming a pending one-shot.
   * Returns `undefined` when no rubric is active.
   */
  show(): string[] | undefined;
  /** Remove both the sticky and the next-turn rubric. */
  clear(): void;
}

function normalizeCriteria(criteria: readonly string[]): string[] {
  if (criteria.length === 0) {
    throw new Error("Turn quality rubric requires at least one criterion.");
  }

  const normalized = criteria.map((criterion) => {
    if (typeof criterion !== "string" || criterion.trim().length === 0) {
      throw new Error("Turn quality rubric criteria must be non-empty strings.");
    }

    return criterion;
  });

  return [...normalized];
}

export function createTurnQualityRubric(): TurnQualityRubric {
  let sticky: string[] | undefined;
  let next: string[] | undefined;

  return {
    setSticky(criteria: readonly string[]): void {
      sticky = normalizeCriteria(criteria);
    },
    setNext(criteria: readonly string[]): void {
      next = normalizeCriteria(criteria);
    },
    consumeForTurn(): string[] | undefined {
      if (next !== undefined) {
        const consumed = next;
        next = undefined;

        return [...consumed];
      }

      return sticky === undefined ? undefined : [...sticky];
    },
    show(): string[] | undefined {
      const effective = next ?? sticky;

      return effective === undefined ? undefined : [...effective];
    },
    clear(): void {
      sticky = undefined;
      next = undefined;
    }
  };
}
