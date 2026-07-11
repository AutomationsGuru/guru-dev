import { exec } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { LifecycleEvents } from "./events.js";
import type { ExtensionApi } from "./api.js";

function getHookScript(name: string): string | null {
  // Try .guru/hooks/name.sh or .bat or .ps1
  const basePath = join(process.cwd(), ".guru", "hooks", name);
  if (existsSync(`${basePath}.sh`)) {
    return `bash ${basePath}.sh`;
  }
  if (existsSync(`${basePath}.bat`)) {
    return `${basePath}.bat`;
  }
  if (existsSync(`${basePath}.ps1`)) {
    return `pwsh -File ${basePath}.ps1`;
  }
  return null;
}

function runHook(name: string, envPayload: Record<string, string>): void {
  const script = getHookScript(name);
  if (!script) return;
  
  exec(script, {
    env: { ...process.env, ...envPayload }
  }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[shell-hooks] Error executing ${name}:`, error.message);
    }
  });
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
}
