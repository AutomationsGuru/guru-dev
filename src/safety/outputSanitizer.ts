import { notifySecretSanitized, scrubSecretValuesReport } from "./secretSafety.js";

/**
 * The render-layer secret sanitizer (ADR 2026-07-05-every-session-dividends;
 * Legend System 6). Deep-walks any tool output and scrubs every string field
 * through the shape+value scrubber — wired at the tool-registry choke point so
 * EVERY tool result passes through it by construction. The documented failure
 * this prevents: `grep`/`cat` on `.env` printing live keys to the terminal and
 * the model; prompt-layer rules cannot stop that, a structural filter can.
 *
 * It also emits the `secret_sanitized` signal (§17.9): the NAMES of the patterns
 * that fired (never the value), so headless surfaces can make redaction auditable.
 * The scrubbed output is byte-identical to before; observers are opt-in.
 */

const MAX_DEPTH = 12;

export function sanitizeToolOutput<T>(output: T): T {
  const matched = new Set<string>();
  const result = walk(output, 0, matched) as T;
  notifySecretSanitized([...matched]);
  return result;
}

function walk(value: unknown, depth: number, matched: Set<string>): unknown {
  if (typeof value === "string") {
    const report = scrubSecretValuesReport(value);
    for (const name of report.matched) {
      matched.add(name);
    }
    return report.text;
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const walked = walk(item, depth + 1, matched);
      if (walked !== item) {
        changed = true;
      }
      return walked;
    });
    return changed ? next : value;
  }
  let changed = false;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const walked = walk(item, depth + 1, matched);
    next[key] = walked;
    if (walked !== item) {
      changed = true;
    }
  }
  return changed ? next : value;
}
