/**
 * Shell tool result normalizer (F254 - R-MA-SHELL-PARSE).
 * Normalizes diverse shell outputs from local and hosted executors
 * into a standardized { stdout, stderr, exitCode } representation.
 */

export interface NormalizedShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Normalizes an unknown raw execution output into a structured NormalizedShellResult.
 *
 * It extracts stdout, stderr, and exitCode from:
 * - A JSON-serialized string representation of a result object.
 * - A raw output string (treating the entire string as stdout).
 * - An object containing typical shell-result properties (stdout, stdOut, output, out, stderr, etc.).
 * - Null/undefined values, returning clean defaults.
 * - Primitive values, treating them as stdout.
 *
 * @param raw - The raw execution result to parse and normalize.
 */
export function parse(raw: unknown): NormalizedShellResult {
  // 1. Handle string inputs (check if it represents JSON)
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parseObject(parsed as Record<string, unknown>);
        }
      } catch {
        // Fall back to treating as a plain string if JSON parsing fails
      }
    }
    return {
      stdout: raw,
      stderr: "",
      exitCode: 0
    };
  }

  // 2. Handle object inputs
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return parseObject(raw as Record<string, unknown>);
  }

  // 3. Handle null or undefined values
  if (raw === null || raw === undefined) {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }

  // 4. Handle other primitive types (numbers, booleans, etc.)
  return {
    stdout: String(raw),
    stderr: "",
    exitCode: 0
  };
}

/**
 * Normalizes an object with potential shell-result keys into NormalizedShellResult.
 */
function parseObject(obj: Record<string, unknown>): NormalizedShellResult {
  // A. Extract stdout (mapping stdout, stdOut, output, out)
  let stdout = "";
  if ("stdout" in obj) {
    stdout = getStringValue(obj.stdout);
  } else if ("stdOut" in obj) {
    stdout = getStringValue(obj.stdOut);
  } else if ("output" in obj) {
    stdout = getStringValue(obj.output);
  } else if ("out" in obj) {
    stdout = getStringValue(obj.out);
  }

  // B. Extract stderr (mapping stderr, stdErr, error, err)
  let stderr = "";
  if ("stderr" in obj) {
    stderr = getStringValue(obj.stderr);
  } else if ("stdErr" in obj) {
    stderr = getStringValue(obj.stdErr);
  } else if ("error" in obj) {
    stderr = getStringValue(obj.error);
  } else if ("err" in obj) {
    stderr = getStringValue(obj.err);
  }

  // C. Extract exitCode (mapping exitCode, exit_code, code, status)
  let exitCode = 0;
  let rawCode: unknown = undefined;

  if ("exitCode" in obj) {
    rawCode = obj.exitCode;
  } else if ("exit_code" in obj) {
    rawCode = obj.exit_code;
  } else if ("code" in obj) {
    rawCode = obj.code;
  } else if ("status" in obj) {
    rawCode = obj.status;
  }

  if (rawCode !== undefined && rawCode !== null) {
    if (typeof rawCode === "number") {
      exitCode = Math.floor(rawCode);
    } else if (typeof rawCode === "string") {
      const parsed = parseInt(rawCode, 10);
      if (!isNaN(parsed)) {
        exitCode = parsed;
      }
    } else if (typeof rawCode === "boolean") {
      exitCode = rawCode ? 1 : 0;
    }
  }

  return {
    stdout,
    stderr,
    exitCode
  };
}

/**
 * Converts any value safely to a string, mapping nullish to empty string.
 */
function getStringValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}
