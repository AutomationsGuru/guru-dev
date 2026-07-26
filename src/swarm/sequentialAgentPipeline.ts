/**
 * Sequential agent pipeline — run agents left-to-right, threading each prior
 * output as the next agent's input. Pure and deterministic; no retry, fan-out,
 * side effects, model calls, or runtime registration.
 *
 * Plan: IDEA-F520-SEQ-01 — exact API `runSequential(agents, task)`.
 */

/**
 * A single step in a sequential pipeline: receives the prior step's output
 * (or the initial task) and returns a value for the next step.
 *
 * The `TOutput` default (`= TInput`) keeps the common homogenous case
 * (T → T → T → …) a single generic parameter.
 */
export type SequentialAgent<TInput, TOutput = TInput> = (
  input: TInput,
) => TOutput;

/**
 * Run a sequence of agents in strict array order. The first agent receives
 * `task`; each subsequent agent receives the prior agent's return value.
 * Returns the final agent's output, or `task` unchanged when `agents` is empty.
 *
 * Pure, deterministic, and synchronous. A throw from any agent propagates
 * immediately — no agent after the thrower runs (lazy in-order).
 */
export function runSequential<T>(
  agents: readonly SequentialAgent<T>[],
  task: T,
): T {
  let value: T = task;
  for (let i = 0; i < agents.length; i++) {
    value = agents[i]!(value);
  }
  return value;
}

/**
 * Curried form: build a pipeline once, apply to many inputs.
 *
 * `sequentialAgentPipeline(agents)(task)` ≡ `runSequential(agents, task)`.
 */
export function sequentialAgentPipeline<T>(
  agents: readonly SequentialAgent<T>[],
): (task: T) => T {
  return (task: T) => runSequential(agents, task);
}
