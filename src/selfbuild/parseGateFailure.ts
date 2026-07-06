/**
 * Gate-output parser (self-build P3) — turn a RED gate's raw stdout/stderr into a
 * STRUCTURED failure note the DEBUG repair loop can carry back into BUILD. Recognises the
 * two gates guru runs against itself (vitest, tsc) and falls back to a generic tail.
 * Deliberately conservative + linear (line-split + per-line test, no catastrophic regex):
 * a parser that misreads output feeds bad notes to the planner and causes fix-break-fix
 * thrash, so it extracts only high-signal lines and caps everything.
 */

export type GateFailureKind = "vitest" | "tsc" | "generic";

export interface GateFailureNote {
  readonly gate: string;
  readonly kind: GateFailureKind;
  readonly summary: string;
  readonly failures: readonly string[];
  /** Truncated raw tail, for the planner to inspect when the extraction misses. */
  readonly raw: string;
}

export interface ParsableGateResult {
  readonly name: string;
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

const MAX_FAILURES = 10;
const MAX_RAW = 2_000;

function detectKind(command: string, text: string): GateFailureKind {
  if (/error TS\d+/u.test(text) || /\b(tsc|typecheck)\b/u.test(command)) {
    return "tsc";
  }
  if (/\b(vitest|jest|mocha|test)\b/u.test(command) || /Test Files|\bFAIL\b/u.test(text)) {
    return "vitest";
  }
  return "generic";
}

function extractTsc(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => /error TS\d+/u.test(line))
    .map((line) => line.trim());
}

function extractVitest(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => /^\s*(FAIL |×|✗|AssertionError|Error:)/u.test(line) || /\bFAIL\b/u.test(line))
    .map((line) => line.trim());
}

function extractGeneric(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseGateFailure(gate: ParsableGateResult): GateFailureNote {
  const text = `${gate.stdout}\n${gate.stderr}`;
  const command = gate.command.join(" ");
  const kind = detectKind(command, text);
  let extracted =
    kind === "tsc" ? extractTsc(text) : kind === "vitest" ? extractVitest(text) : extractGeneric(gate.stderr || gate.stdout);
  // A structured extractor that finds nothing (e.g. `cargo test` matched as "vitest") must
  // NOT silently drop the failure — fall back to the generic tail so DEBUG still gets a note.
  if (extracted.length === 0) {
    extracted = extractGeneric(gate.stderr || gate.stdout || text);
  }
  // De-dup while preserving order, then cap.
  const failures = [...new Set(extracted)].slice(0, MAX_FAILURES);
  const first = failures[0] ? ` — first: ${failures[0]}` : "";
  return {
    gate: gate.name,
    kind,
    summary: `${gate.name} (${kind}) failed with exit ${gate.exitCode ?? "null"}: ${failures.length} issue(s)${first}`,
    failures,
    raw: text.slice(-MAX_RAW)
  };
}
