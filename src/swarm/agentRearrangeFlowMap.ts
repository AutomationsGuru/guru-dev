/**
 * Agent rearrange flow map — parser/validator for the flow-string DSL.
 *
 * Parses textual `a -> b, c` rules into structured edges and validates that
 * every referenced agent name exists in the caller-supplied set.
 *
 * Scope: parser + validation only. No executor, scheduler, cascade policy,
 * alternate graph runtime, framework, or dependency.
 *
 * Contract: R-SW-REARR (IDEA-F518-REARR-01)
 */

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

/** Parse-level error: the input string itself is malformed. */
export class RearrangeParseError extends Error {
  readonly code = "rearrange_parse_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "RearrangeParseError";
  }
}

/** Validation-level error: an agent name referenced in the DSL is unknown. */
export class RearrangeValidationError extends Error {
  readonly code = "rearrange_validation_error" as const;
  constructor(
    message: string,
    /** The unknown agent name that triggered the error. */
    readonly agent: string
  ) {
    super(message);
    this.name = "RearrangeValidationError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single directed flow rule: one source agent flows to one or more targets. */
export interface RearrangeEdge {
  readonly from: string;
  readonly to: readonly string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const ARROW = "->";

/**
 * Parse a flow-map string into validated directed edges.
 *
 * DSL grammar (per rule):
 *   `<agent> -> <agent> [, <agent> ...]`
 *
 * Multiple rules are separated by newlines or semicolons. Whitespace
 * around agent names and separators is stripped.
 *
 * Every agent name referenced (source and every target) must exist in
 * `agentIds`; an unknown name throws {@link RearrangeValidationError}.
 * Malformed input (missing arrow, empty source, no targets) throws
 * {@link RearrangeParseError}.
 *
 * @param input  The flow-string DSL (may be empty — returns `[]`).
 * @param agentIds  The set of known agent identifiers to validate against.
 * @returns  Parsed edges in parse order.
 */
export function parseFlowMap(input: string, agentIds: ReadonlySet<string>): RearrangeEdge[] {
  const raw = input.trim();
  if (raw.length === 0) {
    return [];
  }

  const ruleStrings = raw
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const edges: RearrangeEdge[] = [];

  for (const rule of ruleStrings) {
    const arrowIdx = rule.indexOf(ARROW);
    if (arrowIdx === -1) {
      throw new RearrangeParseError(`Missing '->' in flow rule: "${rule}"`);
    }

    const from = rule.slice(0, arrowIdx).trim();
    if (from.length === 0) {
      throw new RearrangeParseError(`Empty source agent in flow rule: "${rule}"`);
    }

    const targetsStr = rule.slice(arrowIdx + ARROW.length).trim();
    const targets =
      targetsStr.length > 0
        ? targetsStr.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : [];

    if (targets.length === 0) {
      throw new RearrangeParseError(`No target agents in flow rule: "${rule}"`);
    }

    // Validate every referenced name exists.
    validateAgent(from, agentIds);
    for (const t of targets) {
      validateAgent(t, agentIds);
    }

    edges.push({ from, to: targets });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateAgent(name: string, agentIds: ReadonlySet<string>): void {
  if (!agentIds.has(name)) {
    throw new RearrangeValidationError(`Unknown agent "${name}" in flow rule`, name);
  }
}
