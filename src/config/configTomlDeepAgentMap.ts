import type { HarnessConfig } from "./schema.js";
import type { SwarmConfig } from "../swarm/schema.js";

/**
 * Minimal deepagent config.toml keys that Guru can map into its own
 * HarnessConfig. This is an IMPORTER, not a parser — the caller is
 * responsible for reading and providing the object (JSON-parsed or a
 * hand-rolled TOML-lite reader). Only `model` and `sandbox` are
 * recognized; everything else is silently ignored.
 *
 * ## Hard rules (never relaxed by this mapper)
 *
 * - No secrets in config values — `plannerModel.apiKeyEnvVar` is always
 *   an ENV-NAME reference, never a value.
 * - No hardening relaxation — this mapper never weakens risky-path
 *   patterns, shell allowlists, approval policies, or secret scrubbers.
 * - Unknown keys are noted but never reject the input.
 */

// ---------------------------------------------------------------------------
// Input type — what a deepagent config.toml looks like after the caller
// parses it into a plain object.
// ---------------------------------------------------------------------------

export interface DeepAgentConfigTomlInput {
  /** Model identifier string, e.g. "claude-sonnet-5", "gpt-5.5". */
  readonly model?: string;
  /** Remote sandbox block. */
  readonly sandbox?: {
    /** Whether remote sandbox is on. */
    readonly enabled?: boolean;
    /** Provider name: "daytona" | "modal" | "vercel" | "runloop" | etc. */
    readonly provider?: string;
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * A partial HarnessConfig overlay where nested config blocks are also
 * partial — the caller merges this over a DEFAULT and validates with
 * HarnessConfigSchema.
 */
export interface ConfigTomlOverlay {
  plannerModel?: HarnessConfig["plannerModel"];
  swarm?: Partial<SwarmConfig>;
}

export interface ConfigTomlMapResult {
  /** The validated input, with defaults filled for missing optional fields. */
  readonly parsed: DeepAgentConfigTomlInput;
  /** Partial HarnessConfig overlay — only the fields that were mapped. */
  readonly overlay: ConfigTomlOverlay;
  /** Keys in the input that were recognized and mapped. */
  readonly mapped: readonly string[];
  /** Keys in the input that were unrecognized (silently dropped). */
  readonly unrecognized: readonly string[];
}

// ---------------------------------------------------------------------------
// Recognised top-level keys
// ---------------------------------------------------------------------------

const RECOGNISED_KEYS = new Set(["model", "sandbox"]);

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map a deepagent config.toml object into a partial Guru `HarnessConfig`
 * overlay. The overlay is meant to be merged over `DEFAULT_HARNESS_CONFIG`
 * by the caller — it NEVER stands alone as a complete config.
 *
 * Mapping rules (deliberately narrow):
 *
 * | deepagent key | Guru field               | Note                                                |
 * |---------------|--------------------------|-----------------------------------------------------|
 * | `model`       | `plannerModel.model`     | provider/baseUrl/apiKeyEnvVar stay at safe defaults |
 * | `sandbox`     | `swarm.ultraSwarm`       | enabled toggles ultraSwarm on; provider is noted    |
 * | —             | `swarm.maxConcurrentWorkers` | bumped to 8 when sandbox is enabled             |
 *
 * Sandbox-to-swarm mapping is partial (ATTACH gap): deepagent's remote
 * sandbox is a full pluggable-backend concept (Daytona, Modal, Vercel,
 * Runloop). Guru's swarm currently runs workers locally. Mapping
 * sandbox.enabled → ultraSwarm gives the operator the high-concurrency
 * crank but does not wire a remote backend. The provider name is
 * recorded in the result for visibility but has no runtime effect today.
 * A future remote-sandbox adapter (F215) will close this gap.
 *
 * @param obj - Raw object from a parsed config.toml / JSON equivalent.
 */
export function mapDeepAgentConfigToml(obj: unknown): ConfigTomlMapResult {
  const input = validateInput(obj);
  const overlay: ConfigTomlOverlay = {};
  const mapped: string[] = [];
  const unrecognized: string[] = [];

  if (typeof obj === "object" && obj !== null) {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      if (RECOGNISED_KEYS.has(key)) {
        mapped.push(key);
      } else {
        unrecognized.push(key);
      }
    }
  }

  // model → plannerModel.model
  if (input.model !== undefined) {
    overlay.plannerModel = {
      provider: "openai-compatible" as const,
      baseUrl: "https://api.openai.com/v1",
      model: input.model,
      apiKeyEnvVar: "OPENAI_API_KEY",
      timeoutMs: 120_000,
      temperature: 0
    };
  }

  // sandbox → swarm
  if (input.sandbox !== undefined) {
    overlay.swarm = {
      ultraSwarm: input.sandbox.enabled === true,
      // When sandbox is enabled, raise concurrency to match the distributed
      // expectation but stay inside the schema's hard cap (16).
      ...(input.sandbox.enabled === true ? { maxConcurrentWorkers: 8 } : {}),
      // NOTE: provider name is recorded in `parsed` only — Guru has no
      // per-provider swarm field today (see F215 for the remote-adapter gap).
    };
  }

  return { parsed: input, overlay, mapped, unrecognized };
}

/**
 * Convenience: safe-parse without throwing. Returns the result on success
 * or an error diagnostic on failure (never throws).
 */
export function safeMapDeepAgentConfigToml(
  obj: unknown
):
  | { readonly ok: true; readonly result: ConfigTomlMapResult }
  | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, result: mapDeepAgentConfigToml(obj) };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid deepagent config.toml: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Internal validation (no zod needed for two fields — keeps core lighter)
// ---------------------------------------------------------------------------

/** Mutable builder for DeepAgentConfigTomlInput — avoids readonly assignment errors. */
interface MutableDeepAgentConfigTomlInput {
  model?: string;
  sandbox?: {
    enabled?: boolean;
    provider?: string;
  };
}

function validateInput(obj: unknown): DeepAgentConfigTomlInput {
  if (obj === null || obj === undefined) {
    throw new Error("Input must be a non-null object.");
  }
  if (typeof obj !== "object") {
    throw new Error(`Expected an object, got ${typeof obj}.`);
  }

  const record = obj as Record<string, unknown>;
  const result: MutableDeepAgentConfigTomlInput = {};

  if ("model" in record && record.model !== undefined) {
    if (typeof record.model !== "string" || record.model.trim().length === 0) {
      throw new Error(`model must be a non-empty string, got ${typeof record.model}.`);
    }
    result.model = record.model.trim();
  }

  if ("sandbox" in record && record.sandbox !== undefined) {
    const sb = record.sandbox;
    if (sb === null || typeof sb !== "object") {
      throw new Error(`sandbox must be an object, got ${typeof sb}.`);
    }
    const sbRecord = sb as Record<string, unknown>;
    const sandbox: NonNullable<MutableDeepAgentConfigTomlInput["sandbox"]> = {};

    if ("enabled" in sbRecord && sbRecord.enabled !== undefined) {
      if (typeof sbRecord.enabled !== "boolean") {
        throw new Error(`sandbox.enabled must be a boolean, got ${typeof sbRecord.enabled}.`);
      }
      sandbox.enabled = sbRecord.enabled;
    }

    if ("provider" in sbRecord && sbRecord.provider !== undefined) {
      if (typeof sbRecord.provider !== "string" || sbRecord.provider.trim().length === 0) {
        throw new Error(`sandbox.provider must be a non-empty string, got ${typeof sbRecord.provider}.`);
      }
      sandbox.provider = sbRecord.provider.trim();
    }

    // Only attach sandbox if at least one field was present
    if (Object.keys(sandbox).length > 0) {
      result.sandbox = sandbox;
    }
  }

  return result;
}