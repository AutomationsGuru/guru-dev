/**
 * Sequential agent pipeline (IDEA-F520-SEQ-01) — pure, deterministic left-to-right
 * composition over CALLER-SUPPLIED transforms. The harness provides no agents of its
 * own: every step is an ordinary function the operator supplies, and the pipeline
 * simply runs them in order, feeding each prior output into the next transform.
 *
 * This is intentionally a zero-capability primitive. It owns no model, provider,
 * tool, network, file, spend, retry, fan-out, background, or runtime-registration
 * behavior — those concerns live at the extension/tool/role layer (the frozen seam),
 * never inside this kernel-level composition helper. Nothing here can move money,
 * touch a secret, mutate a live system, or self-improve; it cannot, because it does
 * nothing but call pure functions the caller handed it.
 *
 * Contract (testable):
 *  - order is preserved exactly (transforms run in array order, left to right);
 *  - the first transform receives `task` (the initial input);
 *  - each subsequent transform receives the previous transform's output;
 *  - the final transform's output is returned;
 *  - it is pure and synchronous with respect to the caller: it never introduces its
 *    own timing, retries, or side effects beyond what the transforms themselves do.
 */

/**
 * A single sequential step. It is a pure function from the previous output (or the
 * initial `task`) to the next value. Both the intermediate value type `T` and the
 * initial-input/output type may be the same in the common case.
 */
export type SequentialAgent<TInput, TOutput = TInput> = (input: TInput) => TOutput;

/**
 * Run `agents` in order, left to right, threading each output into the next.
 *
 * @param agents  Caller-supplied transforms, in execution order. May be empty.
 * @param task    The initial input handed to the first transform.
 * @returns       The final transform's output, or `task` unchanged when `agents` is empty.
 *
 * Determinism: for a fixed `(agents, task)` the result is fully determined by the
 * transforms' own outputs. No reordering, no fan-out, no retries, no hidden state.
 */
export function runSequential<TInput, TOutput>(
  agents: ReadonlyArray<SequentialAgent<unknown, unknown>>,
  task: TInput
): TOutput {
  let acc: unknown = task;
  for (const agent of agents) {
    acc = agent(acc);
  }
  return acc as TOutput;
}

/**
 * Curried alias: `pipeline(agents)` returns a runnable `(task) => result`. Fully
 * tested in tests/swarm/sequentialAgentPipeline.test.ts. Provided for ergonomics
 * where the agent chain is built once and reused across many inputs.
 */
export function sequentialAgentPipeline<TInput, TOutput>(
  agents: ReadonlyArray<SequentialAgent<unknown, unknown>>
): (task: TInput) => TOutput {
  return (task: TInput): TOutput => runSequential<TInput, TOutput>(agents, task);
}
