export interface TurnContext {
  readonly turnIndex: number;
}

export type TurnTrackingRunner<Input extends object, Result> = (input: Input & TurnContext) => Result;

export function withTurnTracking<Input extends object, Result>(
  runner: TurnTrackingRunner<Input, Result>
): (input: Input) => Result {
  let turnIndex = 0;

  return (input) => runner({ ...input, turnIndex: ++turnIndex });
}
