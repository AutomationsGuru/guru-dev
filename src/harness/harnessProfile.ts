/**
 * Harness profile model (IDEA-F100-HARNESS-PROFILES-01).
 *
 * A harness profile reshapes the model-facing system prompt and tool-schema
 * presentation while Guru's own runtime still executes tools. Profiles never
 * shell out to external agent CLIs; they are pure presentation/strategy data.
 */

/** Profile identifier. Plain string so callers can register custom profiles. */
export type HarnessProfileId = string;

/**
 * How the model expresses tool intent:
 * - `"tools"` — native tool-calling (schemas sent to the model as tools).
 * - `"linear-parse"` — model emits linear text that the runtime parses into
 *   tool calls (for harness shapes without native tool-calling).
 */
export type HarnessResponseMode = "tools" | "linear-parse";

/** Presentation override for a single tool id. */
export interface ToolSurfaceOverride {
  /** Presented label (defaults to the tool's own title). */
  readonly label?: string;
  /** Presented description (defaults to the tool's own description). */
  readonly description?: string;
  /**
   * Hide the tool from the presented surface. Ignored for hard-limit tools —
   * the always-allowed floor cannot be hidden by any profile.
   */
  readonly hidden?: boolean;
}

/**
 * Tool-surface presentation mapping. `include`, when present, narrows the
 * surface to the listed ids — but hard-limit tool ids that exist in the input
 * tool list always survive narrowing (non-bypassable safety floor).
 */
export interface HarnessToolSurface {
  readonly include?: readonly string[];
  readonly overrides?: Readonly<Record<string, ToolSurfaceOverride>>;
}

export interface HarnessProfile {
  readonly id: HarnessProfileId;
  readonly description: string;
  /** Ordered system-prompt fragments presented to the model. */
  readonly systemPromptParts: readonly string[];
  readonly toolSurface: HarnessToolSurface;
  readonly responseMode: HarnessResponseMode;
  /**
   * Hard-limit tool ids for this profile. The registry forces this set to
   * include the non-removable baseline (MANDATE_READ_ONLY_TOOLS), so a profile
   * can widen but never narrow the always-allowed floor.
   */
  readonly hardLimitToolIds: readonly string[];
}

/** One tool as presented to the model after profile resolution. */
export interface PresentedTool {
  readonly toolId: string;
  readonly label: string;
  readonly description: string;
  readonly hidden: boolean;
  /**
   * True when the tool is part of the hard-limit floor: always present on the
   * resolved surface and governed by the mandate layer's deny-auto behavior
   * regardless of profile. The mandate evaluator treats these ids as the
   * never-gated floor; profiles cannot remove, rename-away, or hide them.
   */
  readonly hardLimit: boolean;
}
