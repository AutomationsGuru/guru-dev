import { spawn } from "node:child_process";

import { sanitizeErrorMessage } from "../router/health.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import { DirectChatError, type ChatTurnMessage, type DirectChatResult } from "./directChat.js";
import { getOperatorAuthSpec, resolveOperatorAuthPresence, type OperatorAuthOptions, type OperatorAuthSpec } from "./operatorAuth.js";

/**
 * Delegated plan-auth turn: run the turn through the provider's own CLI (e.g.
 * `codex exec -`), which holds its own operator credentials. The harness never reads
 * token values — this is the documented "smaller honest path" for plan-auth routes,
 * and it structurally honors the policy that operator plan/native auth never routes
 * through LiteLLM (there is no HTTP call from the harness at all).
 *
 * Safety: argv is FIXED (from the provider spec) and the prompt is written to the
 * child's STDIN — so no shell injection and no command-line quoting of user content.
 * On Windows the CLI is a `.cmd` shim, which Node cannot `spawn` directly with
 * shell:false (EINVAL), so we invoke it via `cmd.exe /c` (still fixed argv).
 *
 * Trade-off (documented): delegated turns do NOT get the harness tool loop — the
 * provider CLI runs with its own capabilities in the given cwd.
 */

export interface DelegateExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DelegateExecutor {
  (
    commandName: string,
    args: readonly string[],
    stdinText: string,
    options: { cwd?: string; timeoutMs: number; onOutput?: (chunk: string) => void }
  ): Promise<DelegateExecResult>;
}

export interface CliDelegateOptions extends OperatorAuthOptions {
  readonly executor?: DelegateExecutor;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  /** Stream callback: substantive output lines as the CLI produces them (noise filtered). */
  readonly onToken?: (text: string) => void;
  /**
   * guru's /allow-writes gate, mapped to the delegate CLI's sandbox tier:
   * false/undefined → read-only, true → workspace-write. There is deliberately no
   * path to a full-access/bypass tier.
   */
  readonly writesAllowed?: boolean;
}

/** Compose the final delegate argv: base args + sandbox tier + cwd pin, stdin marker last. */
export function buildDelegateArgs(
  delegate: NonNullable<OperatorAuthSpec["delegate"]>,
  options: Pick<CliDelegateOptions, "writesAllowed" | "cwd"> & { modelId?: string }
): string[] {
  const base = [...delegate.args];
  const marker = base.length > 0 && base[base.length - 1] === "-" ? base.pop() : undefined;
  const sandbox = delegate.sandboxArgs
    ? options.writesAllowed === true
      ? delegate.sandboxArgs.workspaceWrite
      : delegate.sandboxArgs.readOnly
    : [];
  const cwdArgs = delegate.cwdArgs && options.cwd ? delegate.cwdArgs(options.cwd) : [];
  const modelArgs = delegate.modelArgs && options.modelId ? delegate.modelArgs(options.modelId) : [];

  return [...base, ...modelArgs, ...sandbox, ...cwdArgs, ...(marker ? [marker] : [])];
}

export async function runCliDelegateTurn(
  route: ProviderRouteDescriptor,
  messages: readonly ChatTurnMessage[],
  options: CliDelegateOptions = {}
): Promise<DirectChatResult> {
  const spec = getOperatorAuthSpec(route.providerId);
  if (!spec?.delegate) {
    throw new DirectChatError(`No CLI delegation is wired for ${route.providerId} yet.`, { routeId: route.routeId });
  }

  const presence = resolveOperatorAuthPresence(route, options);
  if (!presence.present) {
    throw new DirectChatError(presence.summary, { routeId: route.routeId });
  }

  const prompt = buildDelegatePrompt(messages);
  const executor = options.executor ?? defaultDelegateExecutor;
  const lineStreamer = options.onToken ? createLineStreamer(options.onToken) : undefined;
  const execution = await executor(spec.delegate.commandName, buildDelegateArgs(spec.delegate, { ...options, modelId: route.modelId }), prompt, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    timeoutMs: options.timeoutMs ?? 300_000,
    ...(lineStreamer ? { onOutput: lineStreamer.push } : {})
  });
  lineStreamer?.flush();

  if (execution.exitCode !== 0) {
    throw new DirectChatError(
      `Delegated CLI turn failed (exit ${execution.exitCode ?? "null"}): ${sanitizeErrorMessage(execution.stderr || execution.stdout).slice(0, 300)}`,
      { routeId: route.routeId }
    );
  }

  const maxChars = options.maxOutputChars ?? 60_000;
  const text = extractDelegateText(execution.stdout).slice(0, maxChars);

  return {
    text: text.trim().length > 0 ? text.trim() : "(delegated CLI returned no text output)",
    modelId: route.modelId,
    routeId: route.routeId,
    apiFamily: "native-cli"
  };
}

/** Flatten the recent conversation into a single non-interactive prompt (sent via stdin). */
export function buildDelegatePrompt(messages: readonly ChatTurnMessage[]): string {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content);
  const turns = messages.filter((message) => message.role !== "system");
  const lastUserIndex = turns.map((message) => message.role).lastIndexOf("user");
  const history = turns.slice(0, lastUserIndex === -1 ? undefined : lastUserIndex);
  const ask = lastUserIndex === -1 ? "" : turns[lastUserIndex]?.content ?? "";

  const parts: string[] = [];
  if (system.length > 0) {
    parts.push(system.join("\n"));
  }
  if (history.length > 0) {
    parts.push(
      "Conversation so far:\n" + history.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`).join("\n")
    );
  }
  parts.push(ask);

  return parts.join("\n\n").trim();
}

/** Line-buffered live streamer: emits complete non-noise lines as CLI output arrives. */
export function createLineStreamer(onToken: (text: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = "";
  const emitLine = (line: string): void => {
    if (!isDelegateNoiseLine(line)) {
      onToken(`${line}\n`);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        emitLine(buffer.slice(0, boundary).replace(/\r$/u, ""));
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length > 0) {
        emitLine(buffer);
        buffer = "";
      }
    }
  };
}

function isDelegateNoiseLine(line: string): boolean {
  const noiseRe =
    /^\s*(\d{4}-\d{2}-\d{2}t[\d:.]+z?\b|\[[\d:t.\-\sz]*\]|openai codex|codex v|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|tokens used|-{3,}|error\s+\w|warn\s+\w)/iu;

  return noiseRe.test(line);
}

/** codex exec prints banner/metadata + tool-noise lines around the answer; keep the substantive tail. */
export function extractDelegateText(stdout: string): string {
  const lines = stdout.split(/\r?\n/u);
  const kept = lines.filter((line) => !isDelegateNoiseLine(line));

  return kept.join("\n").trim();
}

const defaultDelegateExecutor: DelegateExecutor = (commandName, args, stdinText, options) => {
  const isWindows = process.platform === "win32";
  // On Windows, .cmd shims cannot be spawned with shell:false (EINVAL) — go through cmd.exe /c.
  // argv stays fixed (no user content), so there is no injection surface; the prompt is on stdin.
  const executable = isWindows ? "cmd.exe" : commandName;
  const spawnArgs = isWindows ? ["/c", commandName, ...args] : [...args];

  return new Promise<DelegateExecResult>((resolveExecution) => {
    const child = spawn(executable, spawnArgs, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolveExecution({ exitCode: null, stdout, stderr: `${stderr}\nDelegated CLI turn timed out after ${options.timeoutMs}ms.` });
      }
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onOutput?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveExecution({ exitCode: null, stdout, stderr: `${stderr}\n${sanitizeErrorMessage(error)}` });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveExecution({ exitCode: code, stdout, stderr });
      }
    });

    child.stdin.on("error", () => {
      /* ignore EPIPE if the child exits before reading all stdin */
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
};
