import {
  executeCommand,
  type CommandExecutionResult,
  type CommandExecutor
} from "../review/gates.js";
import { validatePackData } from "./validate.js";
import type { WorkflowPack, WorkflowPackCheck } from "./schema.js";

/**
 * Run-with-checks for workflow packs (IDEA-F1). The pack runtime is the
 * harness's OWN session engine — injected here so the TUI/RPC surfaces can hand
 * in their real AgentSession factory and tests can hand in a deterministic
 * stub. No third-party agent CLI is ever spawned. Outcome checks run through
 * the owned review/gates command executor (shell-free argv, timeout kill).
 */

/** Minimal session seam the runner needs (AgentSession-compatible). */
export interface WorkflowPackSession {
  prompt(text: string): Promise<{ content: string }>;
}

export type WorkflowPackSessionFactory = (setup: {
  readonly pack: WorkflowPack;
  /** Pack instructions (params expanded) — the caller layers them into the session system prompt. */
  readonly instructions: string;
  /** Pack tool allowlist — the caller restricts offered tools to these ids when present. */
  readonly toolAllowlist: readonly string[] | undefined;
  /** Pack extension allowlist — advisory to the caller's extension host when present. */
  readonly extensionAllowlist: readonly string[] | undefined;
  /** Pack model pin — the caller selects this route/model when present. */
  readonly model: string | undefined;
}) => WorkflowPackSession | Promise<WorkflowPackSession>;

export interface RunPackOptions {
  readonly params?: Readonly<Record<string, string>>;
  readonly createSession: WorkflowPackSessionFactory;
  /** Check executor seam (defaults to the owned review/gates executeCommand). */
  readonly executeCheck?: CommandExecutor;
  /** Working directory for checks (defaults to the process cwd). */
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface WorkflowPackCheckResult {
  readonly name: string;
  readonly command: readonly string[];
  readonly passed: boolean;
  readonly reason?: string;
  readonly execution?: CommandExecutionResult;
}

export interface WorkflowPackAttempt {
  readonly attempt: number;
  /** Final assistant text of the attempt. */
  readonly output: string;
  readonly checks: readonly WorkflowPackCheckResult[];
  readonly checksPassed: boolean;
  /** Present when the pack declares responseJsonSchema and this attempt's output failed it. */
  readonly schemaError?: string;
}

export type RunPackResult =
  | {
      readonly ok: true;
      readonly packId: string;
      readonly attempts: number;
      readonly output: string;
      /** Parsed + schema-validated final object (only when the pack declares responseJsonSchema). */
      readonly structured?: unknown;
      readonly checks: readonly WorkflowPackCheckResult[];
    }
  | {
      readonly ok: false;
      readonly packId: string;
      readonly attempts: number;
      readonly reason: string;
      readonly history: readonly WorkflowPackAttempt[];
    };

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const STRUCTURED_OUTPUT_DIRECTIVE =
  "Your final reply MUST be exactly one JSON value (an object or array) satisfying the pack's responseJsonSchema — no prose, no code fences.";

/**
 * Expand `{{name}}` placeholders in pack text against supplied params and
 * declared defaults. Single pass, literal insertion — a param value containing
 * "{{other}}" is never re-expanded (same rule as prompts/templates).
 */
export function expandPackParams(
  pack: WorkflowPack,
  params: Readonly<Record<string, string>> = {}
): { readonly instructions: string; readonly prompt?: string; readonly missing: readonly string[] } {
  const replacements = new Map<string, string>();
  for (const parameter of pack.parameters ?? []) {
    const supplied = params[parameter.name];
    replacements.set(`{{${parameter.name}}}`, supplied ?? parameter.default ?? "");
  }
  const missing = (pack.parameters ?? [])
    .filter((parameter) => parameter.required === true && (replacements.get(`{{${parameter.name}}}`) ?? "").length === 0)
    .map((parameter) => parameter.name);
  const pattern =
    replacements.size > 0
      ? new RegExp([...replacements.keys()].map((key) => key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu")
      : null;
  const expand = (text: string): string => (pattern === null ? text : text.replace(pattern, (match) => replacements.get(match) ?? match));
  const instructions = expand(pack.instructions);
  const prompt = pack.prompt === undefined ? undefined : expand(pack.prompt);
  return prompt === undefined ? { instructions, missing } : { instructions, prompt, missing };
}

/** Validate a parsed JSON value against the pack's responseJsonSchema subset (draft-07 core). */
export function validateAgainstJsonSchema(value: unknown, schema: Record<string, unknown>, path = "$"): string | null {
  const type = schema.type;
  if (typeof type === "string" && !jsonTypeMatches(value, type)) {
    return `${path}: expected type ${type}, got ${jsonTypeOf(value)}`;
  }
  if (schema.enum !== undefined && Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    return `${path}: value not in enum`;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties;
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
      for (const key of required) {
        if (!(key in record)) {
          return `${path}: missing required property "${key}"`;
        }
      }
      for (const [key, subschema] of Object.entries(properties as Record<string, unknown>)) {
        if (key in record && subschema !== null && typeof subschema === "object" && !Array.isArray(subschema)) {
          const error = validateAgainstJsonSchema(record[key], subschema as Record<string, unknown>, `${path}.${key}`);
          if (error !== null) {
            return error;
          }
        }
      }
    }
    const additional = schema.additionalProperties;
    if (additional === false && properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      const declared = new Set(Object.keys(properties as Record<string, unknown>));
      const extra = Object.keys(record).filter((key) => !declared.has(key));
      if (extra.length > 0) {
        return `${path}: additional properties not allowed: ${extra.join(", ")}`;
      }
    }
  }
  if (Array.isArray(value) && schema.items !== null && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateAgainstJsonSchema(value[index], schema.items as Record<string, unknown>, `${path}[${index}]`);
      if (error !== null) {
        return error;
      }
    }
  }
  return null;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "boolean" ? "boolean" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
}

function jsonTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number";
    case "string": return typeof value === "string";
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return aKeys.length === bKeys.length && aKeys.every((key) => key in bRecord && deepEqual(aRecord[key], bRecord[key]));
}

/** Extract one JSON value from the assistant's final text (strict first, then fenced/embedded object or array). */
export function extractJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // fall through to embedded extraction
  }
  const fenced = /```(?:json)?\s*\r?\n([\s\S]*?)```/u.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    try {
      return JSON.parse(fenced[1].trim()) as unknown;
    } catch {
      // fall through
    }
  }
  for (const opener of ["{", "["] as const) {
    const closer = opener === "{" ? "}" : "]";
    const start = trimmed.indexOf(opener);
    const end = trimmed.lastIndexOf(closer);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        // try the next opener shape
      }
    }
  }
  return undefined;
}

async function runChecks(
  checks: readonly WorkflowPackCheck[],
  executor: CommandExecutor,
  cwd: string | undefined,
  signal: AbortSignal | undefined
): Promise<readonly WorkflowPackCheckResult[]> {
  const results: WorkflowPackCheckResult[] = [];
  for (const check of checks) {
    const name = check.name ?? check.command.join(" ");
    const execution = await executor(check.command, {
      gate: { kind: "validation", name, command: check.command, required: true },
      ...(cwd !== undefined ? { cwd } : {}),
      timeoutMs: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {})
    });
    const reason = checkFailureReason(check, execution);
    results.push({
      name,
      command: check.command,
      passed: reason === null,
      ...(reason !== null ? { reason } : {}),
      execution
    });
  }
  return results;
}

function checkFailureReason(check: WorkflowPackCheck, execution: CommandExecutionResult): string | null {
  const expect = check.expect;
  const expectedExit = expect?.exitCode ?? 0;
  if (execution.exitCode !== expectedExit) {
    return `exit code ${execution.exitCode ?? "null"} (expected ${expectedExit})`;
  }
  if (expect?.stdoutContains !== undefined && !execution.stdout.includes(expect.stdoutContains)) {
    return `stdout missing expected substring`;
  }
  if (expect?.stdoutNotContains !== undefined && execution.stdout.includes(expect.stdoutNotContains)) {
    return `stdout contains forbidden substring`;
  }
  if (expect?.stderrContains !== undefined && !execution.stderr.includes(expect.stderrContains)) {
    return `stderr missing expected substring`;
  }
  return null;
}

/**
 * Run a pack: expand params → fresh session per attempt → optional structured
 * round-trip → outcome checks → bounded retry. Refuses to run an invalid pack
 * and fails closed when a required param is missing or the structured contract
 * cannot be satisfied after the single correction round-trip per attempt.
 */
export async function runPack(packData: unknown, options: RunPackOptions): Promise<RunPackResult> {
  const validation = validatePackData(packData);
  if (!validation.ok) {
    return {
      ok: false,
      packId: "(invalid)",
      attempts: 0,
      reason: `invalid pack: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`,
      history: []
    };
  }
  const pack = validation.pack;
  const packId = pack.id;
  const executor = options.executeCheck ?? executeCommand;
  const checks = pack.checks ?? [];
  const maxAttempts = 1 + (pack.max_retries ?? 0);
  const expanded = expandPackParams(pack, options.params);

  if (expanded.missing.length > 0) {
    return {
      ok: false,
      packId,
      attempts: 0,
      reason: `missing required parameters: ${expanded.missing.join(", ")}`,
      history: []
    };
  }

  const history: WorkflowPackAttempt[] = [];
  const basePrompt = expanded.prompt ?? "Execute the pack instructions now and report the outcome.";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = await options.createSession({
      pack,
      instructions: expanded.instructions,
      toolAllowlist: pack.tools,
      extensionAllowlist: pack.extensions,
      model: pack.model
    });

    let output = (await session.prompt(basePrompt)).content;
    let schemaError: string | undefined;

    if (pack.responseJsonSchema !== undefined) {
      let parsed = extractJsonObject(output);
      let error = parsed === undefined ? "$: final reply is not parseable JSON" : validateAgainstJsonSchema(parsed, pack.responseJsonSchema);
      if (error !== null) {
        // One validation round-trip: tell the session exactly what failed, then fail closed.
        output = (
          await session.prompt(
            `${STRUCTURED_OUTPUT_DIRECTIVE}\nPrevious reply failed validation (${error}). Respond with the corrected JSON value only.`
          )
        ).content;
        parsed = extractJsonObject(output);
        error = parsed === undefined ? "$: final reply is not parseable JSON" : validateAgainstJsonSchema(parsed, pack.responseJsonSchema);
        if (error !== null) {
          schemaError = error;
        }
      }
      if (schemaError === undefined) {
        const checkResults = await runChecks(checks, executor, options.cwd, options.signal);
        const checksPassed = checkResults.every((result) => result.passed);
        history.push({ attempt, output, checks: checkResults, checksPassed });
        if (checksPassed) {
          return { ok: true, packId, attempts: attempt, output, structured: parsed, checks: checkResults };
        }
        continue;
      }
    }

    const checkResults = schemaError === undefined ? await runChecks(checks, executor, options.cwd, options.signal) : [];
    const checksPassed = checkResults.every((result) => result.passed);
    history.push({ attempt, output, checks: checkResults, checksPassed, ...(schemaError !== undefined ? { schemaError } : {}) });

    if (schemaError === undefined && checksPassed) {
      return { ok: true, packId, attempts: attempt, output, checks: checkResults };
    }
  }

  const last = history[history.length - 1];
  const failure =
    last?.schemaError !== undefined
      ? `responseJsonSchema not satisfied after one correction round-trip (${last.schemaError})`
      : `outcome checks failed: ${(last?.checks ?? []).filter((result) => !result.passed).map((result) => `${result.name}${result.reason !== undefined ? ` (${result.reason})` : ""}`).join("; ")}`;
  return { ok: false, packId, attempts: history.length, reason: `${failure} — exhausted ${history.length}/${maxAttempts} attempts`, history };
}
