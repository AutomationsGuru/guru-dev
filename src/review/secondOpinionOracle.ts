export type SecondOpinion = "agree" | "disagree" | "abstain";

export interface SecondOpinionOracleInput {
  readonly claim: string;
  readonly oracleResult: SecondOpinion;
}

export interface SecondOpinionOracleResult extends SecondOpinionOracleInput {
  /** A second opinion must explicitly agree before the candidate may ship. */
  readonly ship: boolean;
}

/**
 * Evaluate a fixture-provided second opinion without calling a model. Abstention
 * fails closed so a missing or inconclusive review never authorizes shipping.
 */
export function evaluate(input: SecondOpinionOracleInput): SecondOpinionOracleResult {
  return {
    ...input,
    ship: input.oracleResult === "agree"
  };
}
