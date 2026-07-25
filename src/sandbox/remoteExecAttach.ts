import { z } from "zod";

/**
 * IDEA-F277 ATTACH stub: interface-only registry for remote exec / FS / shell
 * backends (ssh, container, cloud VM, generic). Mirrors the src/mcp/attach.ts
 * and src/attach/messagingConnector.ts posture — honest default-disabled
 * status, local default, never a surprise network call, no required cloud.
 *
 * R-IDs: R-DA-REMOTE. Composes F173 · F243 · F80.
 *
 * The founding posture (see VISION §1.1 / §1.5): a missing capability resolves
 * to a BUILD / ATTACH / LEARN move. Remote exec is ATTACH-only here — wrapped,
 * approval-gated, status-reported, tracked as a parity gap, and always on a path
 * to native replacement. The local default performs zero I/O and is the only
 * backend that ships enabled-by-shape; every remote backend may be enabled only
 * when a parity gap id (e.g. "R-DA-REMOTE") is attached, so enablement is always
 * traceable to a tracked gap.
 *
 * Secrets are referenced by presence-over-value (env var NAMES only); the config
 * map enforces env-var-NAME-shaped values at the schema level. No remote backend
 * in this wave performs any network I/O — the noop implementation reports itself
 * as a stub and returns a structured, non-delivered result.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const REMOTE_EXEC_PARITY_GAP_ID = "R-DA-REMOTE";

export const RemoteExecBackendKindSchema = z.enum(["local", "ssh", "container", "cloud-vm", "generic"]);
export type RemoteExecBackendKind = z.infer<typeof RemoteExecBackendKindSchema>;

export const RemoteExecBackendStatusSchema = z.enum(["disabled", "ready", "enabled", "error"]);
export type RemoteExecBackendStatus = z.infer<typeof RemoteExecBackendStatusSchema>;

const EnvVarNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]*$/u, "Expected an environment variable name, not a value.");

/**
 * Presence-over-value config map: values are env var NAMES only (e.g. a
 * hostEnvVar-style entry maps to GURU_REMOTE_HOST). Raw secret values, host
 * strings, and any non-env-name-shaped string are rejected by the schema.
 */
export const RemoteExecBackendConfigMapSchema = z.record(z.string(), EnvVarNameSchema);
export type RemoteExecBackendConfigMap = z.infer<typeof RemoteExecBackendConfigMapSchema>;

/**
 * Remote kinds (ssh/container/cloud-vm/generic) require a parity gap id to be
 * enabled; the local kind is always ready by shape and owns no remote host.
 */
const REMOTE_KINDS: readonly RemoteExecBackendKind[] = ["ssh", "container", "cloud-vm", "generic"];

export const RemoteExecBackendConfigSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: RemoteExecBackendKindSchema.default("local"),
    enabled: z.boolean().default(false),
    parityGapId: z.string().trim().min(1).optional(),
    config: RemoteExecBackendConfigMapSchema.default({})
  })
  .strict()
  .superRefine((value, ctx) => {
    const isRemote = (REMOTE_KINDS as readonly string[]).includes(value.kind);
    if (value.enabled && isRemote && !value.parityGapId) {
      ctx.addIssue({
        code: "custom",
        path: ["parityGapId"],
        message: `parityGapId (e.g. "${REMOTE_EXEC_PARITY_GAP_ID}") is required to enable remote backend "${value.id}".`
      });
    }
  });
export type RemoteExecBackendConfig = z.infer<typeof RemoteExecBackendConfigSchema>;
/** Input shape: fields with schema defaults (kind, enabled, config) may be omitted. */
export type RemoteExecBackendConfigInput = z.input<typeof RemoteExecBackendConfigSchema>;

export const RemoteExecExecResultSchema = z
  .object({
    delivered: z.boolean(),
    reason: z.string().trim().min(1),
    backendId: z.string().trim().min(1)
  })
  .strict();
export type RemoteExecExecResult = z.infer<typeof RemoteExecExecResultSchema>;

export const RemoteExecListResultSchema = z
  .object({
    ok: z.boolean(),
    entries: z.array(z.string())
  })
  .strict();
export type RemoteExecListResult = z.infer<typeof RemoteExecListResultSchema>;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * A remote exec backend abstracts where FS/shell operations run. The local
 * backend is the default and performs real in-process string composition (path
 * resolution) but no real FS listing; remote backends are noop stubs until a
 * native replacement lands behind the same interface.
 */
export interface RemoteExecBackend {
  readonly id: string;
  readonly kind: RemoteExecBackendKind;
  readonly status: RemoteExecBackendStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Execute a shell command. Remote stubs never dial out and report delivered=false. */
  exec(command: string): Promise<RemoteExecExecResult>;
  /** Resolve a workspace-relative path against the backend's working root. */
  resolvePath(relativePath: string): Promise<string>;
  /** List entries under a path. Local stub returns ok=true with an empty list. */
  listFiles(path: string): Promise<RemoteExecListResult>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const REMOTE_EXEC_PARITY_GAP_PREFIX = "RemoteExecParityGapRequired";

export class RemoteExecParityGapError extends Error {
  public readonly backendId: string;

  constructor(backendId: string) {
    super(
      `${REMOTE_EXEC_PARITY_GAP_PREFIX}: remote backend "${backendId}" cannot be enabled without a parityGapId (e.g. "${REMOTE_EXEC_PARITY_GAP_ID}").`
    );
    this.name = "RemoteExecParityGapError";
    this.backendId = backendId;
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function parseConfig(config: RemoteExecBackendConfigInput): RemoteExecBackendConfig {
  const result = RemoteExecBackendConfigSchema.safeParse(config);
  if (!result.success) {
    const gapIssue = result.error.issues.find((issue) => issue.path.includes("parityGapId"));
    if (gapIssue) {
      const id = typeof config === "object" && config && "id" in config ? String(config.id) : "unknown";
      throw new RemoteExecParityGapError(id);
    }
    throw result.error;
  }
  // Defense-in-depth: the schema's superRefine already enforces this invariant.
  const isRemote = (REMOTE_KINDS as readonly string[]).includes(result.data.kind);
  if (result.data.enabled && isRemote && !result.data.parityGapId) {
    throw new RemoteExecParityGapError(result.data.id);
  }
  return result.data;
}

/**
 * Local backend: the default. Owns no remote host, so it is always "ready" and
 * connect/disconnect are noop-safe. resolvePath performs pure string composition
 * (workspace-relative join) with no network or FS syscall. listFiles returns an
 * ok stub with no entries. This is the only backend that ships usable-by-shape.
 */
export function createLocalRemoteExecBackend(config: RemoteExecBackendConfigInput): RemoteExecBackend {
  const parsed = parseConfig(config);
  if (parsed.kind !== "local") {
    // Caller used the local factory for a remote kind; honor the requested kind
    // but keep local semantics out of remote backends. Re-route to the noop path.
    return createNoopRemoteExecBackend(config);
  }
  return {
    id: parsed.id,
    kind: "local",
    status: "ready",
    async connect() {
      /* local owns no remote session; always ready */
    },
    async disconnect() {
      /* local owns no remote session; always ready */
    },
    async exec(_command: string): Promise<RemoteExecExecResult> {
      // Local backend does not execute shell commands through this ATTACH seam;
      // real local exec lives in the owned sandbox executor. This stub reports
      // itself honestly as a non-delivering noop, never a surprise side effect.
      return { delivered: false, reason: "local-noop", backendId: parsed.id };
    },
    async resolvePath(relativePath: string): Promise<string> {
      // Pure in-process path composition. Reject embedded NULs; never touch FS.
      const cleaned = String(relativePath).replace(/\0+/gu, "");
      return cleaned.length > 0 ? cleaned : ".";
    },
    async listFiles(_path: string): Promise<RemoteExecListResult> {
      // Stub wave: local FS listing belongs to the owned repo/sandbox layer.
      // This seam stays interface-only and reports success with no entries.
      return { ok: true, entries: [] };
    }
  };
}

/**
 * Noop backend for remote kinds (ssh/container/cloud-vm/generic). Performs zero
 * network I/O; surfaces as enabled only when a parity gap id is attached.
 */
export function createNoopRemoteExecBackend(config: RemoteExecBackendConfigInput): RemoteExecBackend {
  const parsed = parseConfig(config);
  let status: RemoteExecBackendStatus = parsed.enabled ? "ready" : "disabled";

  return {
    id: parsed.id,
    kind: parsed.kind,
    get status() {
      return status;
    },
    async connect() {
      if (!parsed.enabled) {
        status = "disabled";
        return;
      }
      // Stub wave: no real remote session exists; enabling surfaces the backend
      // as "enabled" without performing any network I/O.
      status = "enabled";
    },
    async disconnect() {
      status = parsed.enabled ? "ready" : "disabled";
    },
    async exec(_command: string): Promise<RemoteExecExecResult> {
      // Noop stub: never throws, never executes remotely, never performs network I/O.
      return { delivered: false, reason: "noop-stub", backendId: parsed.id };
    },
    async resolvePath(relativePath: string): Promise<string> {
      const cleaned = String(relativePath).replace(/\0+/gu, "");
      return cleaned.length > 0 ? cleaned : ".";
    },
    async listFiles(_path: string): Promise<RemoteExecListResult> {
      return { ok: false, entries: [] };
    }
  };
}

/** Build the right backend for a config: local kind → local factory, else noop. */
export function createRemoteExecBackend(config: RemoteExecBackendConfigInput): RemoteExecBackend {
  const parsed = RemoteExecBackendConfigSchema.safeParse(config);
  const kind = parsed.success ? parsed.data.kind : "local";
  return kind === "local" ? createLocalRemoteExecBackend(config) : createNoopRemoteExecBackend(config);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Small in-memory registry; backends default to disabled. */
const backends = new Map<string, RemoteExecBackend>();

export function registerRemoteExecBackend(config: RemoteExecBackendConfigInput): RemoteExecBackend {
  const backend = createRemoteExecBackend(config);
  backends.set(backend.id, backend);
  return backend;
}

export function getRemoteExecBackend(id: string): RemoteExecBackend | undefined {
  return backends.get(id);
}

export function listRemoteExecBackends(): readonly RemoteExecBackend[] {
  return [...backends.values()];
}

export function removeRemoteExecBackend(id: string): boolean {
  return backends.delete(id);
}
