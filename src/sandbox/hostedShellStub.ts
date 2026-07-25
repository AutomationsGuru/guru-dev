/**
 * Hosted shell stub (IDEA-F252-HOSTED-SHELL-01 / R-MA-HOSTED).
 *
 * Interface for container_auto-style hosted/managed shell exec.
 * Default implementation is fail-closed not-configured — no provider
 * container runtime is attached until an explicit ATTACH supplies one.
 *
 * Composes with F243 shell backend selector (local vs hosted).
 * Zero external deps; no Azure/MAF rehost.
 */

export const HOSTED_SHELL_BACKEND_ID = "hosted" as const;
export const HOSTED_SHELL_NOT_CONFIGURED_CODE = "not-configured" as const;

export interface HostedShellExecRequest {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface HostedShellExecSuccess {
  readonly ok: true;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly cancelled?: boolean;
}

export interface HostedShellExecFailure {
  readonly ok: false;
  readonly code: typeof HOSTED_SHELL_NOT_CONFIGURED_CODE | (string & {});
  readonly message: string;
}

export type HostedShellExecResult = HostedShellExecSuccess | HostedShellExecFailure;

export interface HostedShellBackend {
  readonly id: string;
  readonly kind: "hosted";
  /**
   * Execute a command in a hosted/container_auto environment.
   * The default stub always fails closed with code `not-configured`.
   */
  exec(request: HostedShellExecRequest): Promise<HostedShellExecResult>;
}

/** Clear fail-closed message used by the default stub. */
export const HOSTED_SHELL_NOT_CONFIGURED_MESSAGE =
  "Hosted shell is not configured. No container_auto provider is attached; exec fails closed.";

export function createHostedShellStub(options?: {
  readonly id?: string;
}): HostedShellBackend {
  const id = options?.id ?? HOSTED_SHELL_BACKEND_ID;
  return {
    id,
    kind: "hosted",
    async exec(_request) {
      return {
        ok: false,
        code: HOSTED_SHELL_NOT_CONFIGURED_CODE,
        message: HOSTED_SHELL_NOT_CONFIGURED_MESSAGE,
      };
    },
  };
}

/** Module-level default stub (fail-closed). */
export const defaultHostedShellStub: HostedShellBackend = createHostedShellStub();

/** Convenience: exec via the default fail-closed stub. */
export function execHostedShell(
  request: HostedShellExecRequest,
): Promise<HostedShellExecResult> {
  return defaultHostedShellStub.exec(request);
}
