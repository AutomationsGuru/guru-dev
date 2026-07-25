/**
 * Sandbox executor registry (IDEA-F630-SANDBOX-01 / R-SM-SANDBOX).
 *
 * Resolve docker|mock. Unrestricted local (`local` / `unrestricted`) fails
 * closed unless `allowUnrestrictedLocal === true`. Unknown ids fail closed.
 *
 * This module is pure registry/resolve only — no process spawn, no container
 * lifecycle, no third-party sandbox rehost.
 */

export type ExecutorId = "docker" | "mock";

export interface Executor {
  readonly id: ExecutorId;
  readonly label: string;
}

export type ResolveResult =
  | { readonly ok: true; readonly executor: Executor }
  | { readonly ok: false; readonly reason: string };

export interface ResolveOptions {
  /**
   * When true, `local` / `unrestricted` resolve instead of failing closed.
   * Default (absent/false) keeps unrestricted local denied.
   */
  readonly allowUnrestrictedLocal?: boolean;
}

const DOCKER: Executor = Object.freeze({ id: "docker", label: "Docker sandbox" });
const MOCK: Executor = Object.freeze({ id: "mock", label: "Mock sandbox" });

const REGISTRY: readonly Executor[] = Object.freeze([DOCKER, MOCK]);

/** Ids that mean unrestricted host/local execution (never a default security path). */
const UNRESTRICTED_ALIASES = new Set(["local", "unrestricted", "local_unrestricted"]);

/**
 * Synthetic executor returned only when unrestricted local is explicitly allowed.
 * Kept under `mock` id so the public `ExecutorId` union stays docker|mock only;
 * the label marks the opt-in unrestricted path for callers/logs.
 */
const UNRESTRICTED_LOCAL: Executor = Object.freeze({
  id: "mock",
  label: "Unrestricted local (explicit allow)"
});

export function listExecutors(): readonly Executor[] {
  return REGISTRY;
}

export function resolve(id: string, opts?: ResolveOptions): ResolveResult {
  const key = typeof id === "string" ? id.trim().toLowerCase() : "";
  if (!key) {
    return { ok: false, reason: "empty executor id" };
  }

  if (UNRESTRICTED_ALIASES.has(key)) {
    if (opts?.allowUnrestrictedLocal === true) {
      return { ok: true, executor: UNRESTRICTED_LOCAL };
    }
    return {
      ok: false,
      reason: "unrestricted local executor fails closed by default"
    };
  }

  if (key === "docker") {
    return { ok: true, executor: DOCKER };
  }
  if (key === "mock") {
    return { ok: true, executor: MOCK };
  }

  return { ok: false, reason: `unknown executor: ${key}` };
}
