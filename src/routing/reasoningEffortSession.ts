/**
 * Session reasoning effort.
 *
 * Maps a session-level reasoning effort (none/minimal/low/medium/high) to
 * provider request knobs (OpenAI-style `reasoning_effort` for chat completions,
 * `reasoning: { effort }` for the responses API) WITHOUT changing the model id.
 * Callers are responsible for merging these params into their provider request;
 * this module never emits or mutates a model identifier.
 */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface ReasoningEffortParams {
  /** OpenAI-style reasoning effort. `undefined` disables reasoning effort. */
  reasoning_effort: 'minimal' | 'low' | 'medium' | 'high' | undefined;
  /** Whether to enable a thinking/reasoning channel for this level. */
  thinking: boolean;
}

const effortMap: Record<ReasoningEffort, ReasoningEffortParams> = {
  none: { reasoning_effort: undefined, thinking: false },
  minimal: { reasoning_effort: 'minimal', thinking: false },
  low: { reasoning_effort: 'low', thinking: true },
  medium: { reasoning_effort: 'medium', thinking: true },
  high: { reasoning_effort: 'high', thinking: true },
};

const DEFAULT_EFFORT: ReasoningEffort = 'medium';

let currentEffort: ReasoningEffort = DEFAULT_EFFORT;

/**
 * Set the current session reasoning effort.
 * Throws on unknown levels so callers cannot silently fall through.
 */
export function setEffort(effort: ReasoningEffort): void {
  if (!(effort in effortMap)) {
    throw new Error(`Invalid reasoning effort: ${effort}`);
  }
  currentEffort = effort;
}

/** Returns the current session reasoning effort. */
export function getEffort(): ReasoningEffort {
  return currentEffort;
}

/** Resets the session reasoning effort to the default ('medium'). */
export function clear(): void {
  currentEffort = DEFAULT_EFFORT;
}

/**
 * Returns the provider request knobs for the given effort, defaulting to the
 * current effort when omitted. Never changes or emits a model id.
 */
export function toProviderParams(
  effort?: ReasoningEffort,
): ReasoningEffortParams {
  const resolved = effort ?? currentEffort;
  const params = effortMap[resolved];
  if (!params) {
    throw new Error(`Invalid reasoning effort: ${resolved}`);
  }
  return params;
}

export { effortMap };
