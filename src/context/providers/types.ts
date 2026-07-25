/**
 * Context providers (IDEA-F90-CTX-PROVIDERS-01).
 *
 * Pluggable, budgeted context snippets injected into a model turn. A provider
 * owns one source of context (git diff, open files, terminal selection, a
 * folder) and answers a single question: given a token budget, what is the
 * highest-value slice of context to surface right now?
 *
 * This module is intentionally framework-free and model-agnostic: it produces
 * typed snippets and a budgeted registry, and never touches the agent loop,
 * a provider CLI, or an orchestration SDK. New providers register through
 * {@link ContextRegistry.register} rather than editing any core surface.
 */

/**
 * A budget is measured in characters, not tokens. Providers stay decoupled
 * from any specific tokenizer; the registry slices with a simple character
 * ceiling, which is the conservative upper bound across tokenizers. A future
 * provider may attach its own token estimate; the character budget remains the
 * hard cap the registry enforces.
 */
export interface ContextBudget {
  /** Hard character ceiling across all snippets a provider may return. */
  readonly maxChars: number;
}

/** A single, self-contained slice of context surfaced to the model. */
export interface ContextSnippet {
  /** Stable identifier within the provider (e.g. "unstaged", "open-file:foo.ts"). */
  readonly id: string;
  /** Human-readable label shown in any context preamble. */
  readonly label: string;
  /** The context body. Must already be plain text — never a secret value. */
  readonly body: string;
  /**
   * Optional ordering hint relative to siblings (lower surfaces earlier when
   * the registry must truncate). Defaults to 0.
   */
  readonly priority?: number;
}

/**
 * A provider collects context within a budget. Implementations must be
 * deterministic and side-effect-free for a given input; expensive work (git,
 * filesystem) belongs behind an injected executor so the provider stays testable
 * and the absence of the underlying tool degrades to "no snippets" rather than
 * an error.
 */
export interface ContextProvider {
  /** Stable, unique provider id (e.g. "git-diff"). */
  readonly id: string;
  /** Human-readable name for menus and telemetry. */
  readonly label: string;
  /**
   * Return the highest-value snippets that fit within {@link budget}.
   *
   * Implementations should not throw for ordinary "nothing to surface" states
   * (no git, clean tree, empty selection); return an empty array instead. Throw
   * only for genuine programmer errors.
   */
  collect(budget: ContextBudget): Promise<readonly ContextSnippet[]> | readonly ContextSnippet[];
}
