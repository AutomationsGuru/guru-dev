export type EvalMetricScorer<TInput, TScore> = (input: TInput) => TScore;

export interface EvalMetricRegistry<TInput, TScore> {
  readonly register: (id: string, scorer: EvalMetricScorer<TInput, TScore>) => void;
  readonly get: (id: string) => EvalMetricScorer<TInput, TScore> | undefined;
  readonly list: () => readonly string[];
  readonly score: (id: string, input: TInput) => TScore;
}

export function createEvalMetricRegistry<TInput, TScore>(): EvalMetricRegistry<TInput, TScore> {
  const scorers = new Map<string, EvalMetricScorer<TInput, TScore>>();

  return {
    register(id, scorer) {
      if (scorers.has(id)) {
        throw new Error(`Metric already registered: ${id}`);
      }
      scorers.set(id, scorer);
    },
    get(id) {
      return scorers.get(id);
    },
    list() {
      return [...scorers.keys()].sort((left, right) => left.localeCompare(right));
    },
    score(id, input) {
      const scorer = scorers.get(id);
      if (!scorer) {
        throw new Error(`Metric not registered: ${id}`);
      }
      return scorer(input);
    }
  };
}
