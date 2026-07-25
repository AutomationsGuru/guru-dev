import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Remote sandbox backend seam (IDEA-F215-REMOTE-SBX-01, R-DA-REMOTE).
 *
 * GuruHarness owns its runtime; a remote sandbox (Daytona, Modal, …) is an
 * explicit ATTACH, never a silent foundation. This interface is the frozen
 * seam such an adapter registers against: exec / read / write addressed by an
 * opaque backend id. The only implementation shipped here is the local stub —
 * no live remote dependencies, no sandboxing claims (F80 owns enforcement).
 *
 * Composes: F173 external sandbox · F80.
 */

/** Opaque identifier for a sandbox backend instance (e.g. "local", "daytona:ws-123"). */
export type RemoteSandboxBackendId = string;

export interface RemoteSandboxExecRequest {
  /** Command argv — no shell interpolation; adapters MUST NOT join into a shell string. */
  readonly command: readonly string[];
  /** Working directory inside the sandbox; defaults to the adapter's sandbox root. */
  readonly cwd?: string;
  /** Extra environment for this exec only; never carries secrets in values. */
  readonly env?: Readonly<Record<string, string>>;
  /** Kill the exec when this elapses; result reports `cancelled: true`. */
  readonly timeoutMs?: number;
  /** Abort seam: an external abort kills the exec the same way as a timeout. */
  readonly signal?: AbortSignal;
}

export interface RemoteSandboxExecResult {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when killed by timeout or abort; output is partial. */
  readonly cancelled?: boolean;
}

export interface RemoteSandboxReadRequest {
  /** Path inside the sandbox, resolved against the adapter's sandbox root. */
  readonly path: string;
}

export interface RemoteSandboxReadResult {
  readonly content: string;
}

export interface RemoteSandboxWriteRequest {
  /** Path inside the sandbox, resolved against the adapter's sandbox root. */
  readonly path: string;
  readonly content: string;
}

/** Write acknowledgement — reserved for adapter-reported metadata (bytes written, etc.). */
export interface RemoteSandboxWriteResult {}

export interface RemoteSandboxBackend {
  /** Stable id this backend instance answers to. */
  readonly id: RemoteSandboxBackendId;
  /**
   * Honest capability report: adapters that cannot honor a request reject with
   * an error — they never silently degrade to a different backend.
   */
  readonly kind: string;
  exec(request: RemoteSandboxExecRequest): Promise<RemoteSandboxExecResult>;
  read(request: RemoteSandboxReadRequest): Promise<RemoteSandboxReadResult>;
  write(request: RemoteSandboxWriteRequest): Promise<RemoteSandboxWriteResult>;
}

export const LOCAL_STUB_BACKEND_ID = "local" as const;

export interface LocalStubBackendOptions {
  /** Root the stub resolves read/write paths against. Defaults to process.cwd(). */
  readonly rootDir?: string;
}

/**
 * Stub local adapter: exec via `execFile`, read/write via node:fs against a
 * root directory. It exists so the seam is exercisable end-to-end in tests and
 * by future adapters' contract tests — it is NOT a sandbox and makes no
 * isolation claims.
 */
export class LocalStubBackend implements RemoteSandboxBackend {
  readonly id = LOCAL_STUB_BACKEND_ID;
  readonly kind = "local-stub";

  private readonly rootDir: string;

  constructor(options: LocalStubBackendOptions = {}) {
    this.rootDir = options.rootDir ?? process.cwd();
  }

  exec(request: RemoteSandboxExecRequest): Promise<RemoteSandboxExecResult> {
    if (request.command.length === 0) {
      return Promise.reject(new Error("exec requires a non-empty command argv."));
    }
    const [file, ...args] = request.command;
    const startedAt = Date.now();
    return new Promise((resolvePromise, rejectPromise) => {
      const child = execFile(
        file!,
        args,
        {
          cwd: request.cwd ?? this.rootDir,
          ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
          ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
          ...(request.signal ? { signal: request.signal } : {})
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startedAt;
          if (error && error.code === undefined && !error.killed) {
            // Spawn failure (e.g. ENOENT) — there is no process result to report.
            rejectPromise(error);
            return;
          }
          const killedByTimeout = Boolean(error?.killed);
          const aborted = Boolean(request.signal?.aborted);
          resolvePromise({
            exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
            ...(typeof error?.signal === "string" && error.signal ? { signal: error.signal } : {}),
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            durationMs,
            ...(killedByTimeout || aborted ? { cancelled: true } : {})
          });
        }
      );
      child.on("error", () => {
        /* handled via callback */
      });
    });
  }

  async read(request: RemoteSandboxReadRequest): Promise<RemoteSandboxReadResult> {
    const content = await readFile(this.resolvePath(request.path), "utf8");
    return { content };
  }

  async write(request: RemoteSandboxWriteRequest): Promise<RemoteSandboxWriteResult> {
    const target = this.resolvePath(request.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, request.content, "utf8");
    return {};
  }

  private resolvePath(path: string): string {
    return resolve(this.rootDir, path);
  }
}
