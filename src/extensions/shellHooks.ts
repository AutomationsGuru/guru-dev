import { execFile } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { LifecycleEvents } from "./events.js";
import type { ExtensionApi } from "./api.js";

interface HookInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

const UNSERIALIZABLE_TOOL_RESULT = '{"status":"unknown","error":"unserializable tool result"}';

/**
 * Resolve `.guru/hooks/<name>.{sh,ps1}` to an argv-array invocation. Hooks run
 * via execFile (never a shell-parsed string) so a cwd containing spaces or
 * metacharacters cannot alter the command (CodeQL
 * js/shell-command-injection-from-environment). `.bat` hooks are unsupported:
 * batch requires cmd.exe, which re-parses its whole line — use `.ps1` on
 * Windows instead.
 */
function getHookScript(name: string): HookInvocation | null {
  const basePath = join(process.cwd(), ".guru", "hooks", name);
  if (existsSync(`${basePath}.sh`)) {
    return { file: "bash", args: [`${basePath}.sh`] };
  }
  if (existsSync(`${basePath}.ps1`)) {
    return { file: "pwsh", args: ["-NoProfile", "-File", `${basePath}.ps1`] };
  }
  return null;
}

function runHook(name: string, envPayload: Record<string, string>): void {
  const script = getHookScript(name);
  if (!script) return;

  execFile(script.file, [...script.args], {
    env: { ...process.env, ...envPayload }
  }, (error) => {
    if (error) {
      console.error(`[shell-hooks] Error executing ${name}:`, error.message);
    }
  });
}

function getToolResultStatus(output: unknown): "succeeded" | "failed" | "unknown" {
  try {
    if (typeof output !== "object" || output === null || !("status" in output)) {
      return "unknown";
    }

    const status = (output as { readonly status?: unknown }).status;
    return status === "succeeded" || status === "failed" ? status : "unknown";
  } catch {
    return "unknown";
  }
}

function serializeToolResult(output: unknown): string {
  try {
    const serialized = JSON.stringify(output);
    return typeof serialized === "string" ? serialized : UNSERIALIZABLE_TOOL_RESULT;
  } catch {
    return UNSERIALIZABLE_TOOL_RESULT;
  }
}

export function registerShellHooks(api: ExtensionApi): void {
  api.on(LifecycleEvents.SESSION_START, (payload) => {
    runHook("session-start", { GURU_SESSION_ID: payload.sessionId });
  });

  api.on(LifecycleEvents.TOOL_EXECUTE, (payload) => {
    runHook("tool-execute", {
      GURU_TOOL_ID: payload.toolId,
      GURU_TOOL_INPUT: typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input)
    });
  });

  api.on(LifecycleEvents.TOOL_RESULT, (payload) => {
    runHook("tool-result", {
      GURU_TOOL_ID: payload.toolId,
      GURU_TOOL_STATUS: getToolResultStatus(payload.output),
      GURU_TOOL_OUTPUT: serializeToolResult(payload.output)
    });
  });
}
