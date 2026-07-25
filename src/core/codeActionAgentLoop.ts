/**
 * Code action agent loop — IDEA-F628-CODEACT-01 / R-SM-CODE.
 *
 * Parse code-style action lines, invoke tools as functions, stop on
 * final_answer or when maxSteps is exhausted. Unknown tools fail closed
 * as step error strings. Pure callables only; local unrestricted code
 * exec is not a security path (tools are explicit invokers).
 */

export type Action =
  | { kind: "tool"; name: string; args: string }
  | { kind: "final_answer"; text: string };

export type ToolFn = (args: string) => string;

export interface LoopResult {
  readonly steps: readonly string[];
  readonly answer: string | null;
  readonly stopped: "final_answer" | "maxSteps";
}

const DEFAULT_MAX_STEPS = 8;

function stripFence(line: string): string {
  const trimmed = line.trim();
  const fenced = trimmed.match(/^```(?:[A-Za-z0-9_+-]*)?\s*([\s\S]*?)\s*```$/);
  if (fenced) {
    return fenced[1]!.trim();
  }
  return trimmed;
}

function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Parse one action line into a tool call or final_answer.
 *
 * Accepts:
 * - function-call form: `name(args)` / `final_answer(text)`
 * - labeled form: `tool name: args` / `final_answer: text`
 * Optional single-line code fences are stripped first.
 * Returns null when the line is empty or not a recognized action.
 */
export function parseAction(line: string): Action | null {
  if (typeof line !== "string") {
    return null;
  }
  const body = stripFence(line);
  if (!body) {
    return null;
  }

  const labeledFinal = /^final_answer\s*:\s*(.*)$/i.exec(body);
  if (labeledFinal) {
    return { kind: "final_answer", text: unquote(labeledFinal[1] ?? "") };
  }

  const labeledTool = /^tool\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/i.exec(body);
  if (labeledTool) {
    return { kind: "tool", name: labeledTool[1]!, args: labeledTool[2] ?? "" };
  }

  const open = body.indexOf("(");
  if (open > 0 && body.endsWith(")")) {
    const name = body.slice(0, open).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      const args = body.slice(open + 1, -1);
      if (name === "final_answer") {
        return { kind: "final_answer", text: unquote(args) };
      }
      return { kind: "tool", name, args };
    }
  }

  return null;
}

/**
 * Run a code-action agent loop.
 *
 * Each iteration:
 *   1. `decide(history)` → one action line (recorded in steps)
 *   2. parse → final_answer stops; tool invokes `tools[name](args)` and
 *      appends the observation (or a fail-closed error string) to steps
 *
 * `maxSteps` defaults to 8. Unknown tools and unparseable lines fail closed
 * as step error strings and do not throw.
 */
export function runCodeActionLoop(
  decide: (history: readonly string[]) => string,
  tools: Readonly<Record<string, ToolFn>>,
  opts?: { maxSteps?: number }
): LoopResult {
  const maxSteps = opts?.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isFinite(maxSteps) || maxSteps < 1) {
    throw new Error(
      `runCodeActionLoop: maxSteps must be >= 1 (got ${String(maxSteps)})`
    );
  }
  const limit = Math.trunc(maxSteps);
  const steps: string[] = [];

  for (let i = 0; i < limit; i += 1) {
    const line = decide(steps);
    steps.push(line);

    const action = parseAction(line);
    if (action === null) {
      steps.push(`error: unparseable action: ${line}`);
      continue;
    }

    if (action.kind === "final_answer") {
      return {
        steps: Object.freeze(steps.slice()) as readonly string[],
        answer: action.text,
        stopped: "final_answer"
      };
    }

    const fn = tools[action.name];
    if (fn === undefined) {
      steps.push(`error: unknown tool: ${action.name}`);
      continue;
    }

    try {
      const out = fn(action.args);
      steps.push(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push(`error: tool ${action.name} threw: ${message}`);
    }
  }

  return {
    steps: Object.freeze(steps.slice()) as readonly string[],
    answer: null,
    stopped: "maxSteps"
  };
}
