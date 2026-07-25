import { execFile } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import {
  LifecycleEvents,
  mergePreToolHookDecisions,
  PRE_TOOL_DECISION_ALLOW,
  type PreToolHook,
  type PreToolHookDecision,
  type PreToolHookInvocation
} from "./events.js";
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

/* -------------------------------------------------------------------------- */
/* Pre-tool deciding hooks (IDEA-D5)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Upper bound on a deciding pre-tool hook's wall time. A hook that runs past
 * this is killed and its contribution is a fail-closed `ask` (never a silent
 * allow): a stuck hook must not hang the tool loop, and must not default-open.
 */
const PRE_TOOL_HOOK_TIMEOUT_MS = 5_000;

/** Bounded stdout capture — a hook cannot exhaust memory through output. */
const PRE_TOOL_HOOK_MAX_BUFFER = 64 * 1024;

/**
 * Whether a project-local (`.guru/hooks/`) deciding hook may run. Per the plan:
 * project hooks only after trust. There is no durable project-trust model in the
 * extension layer yet, so the fail-closed default is USER-GLOBAL ONLY: the
 * project hook is skipped unless the operator explicitly opts the project in via
 * `GURU_TRUST_PROJECT_HOOKS=1` (presence of the env name only — never a secret).
 * When a real trust model lands (LifecycleEvents.PROJECT_TRUST), this predicate
 * is the single seam where it plugs in.
 */
function isProjectHookTrusted(): boolean {
  return process.env.GURU_TRUST_PROJECT_HOOKS === "1";
}

/**
 * Parse one decision line from a deciding hook's stdout. The hook contract is a
 * single JSON object on the LAST non-empty stdout line, shaped:
 *   {"decision":"allow"}
 *   {"decision":"ask","reason":"..."}
 *   {"decision":"deny","reason":"..."}
 *   {"decision":"updatedInput","input":<any>}
 *
 * Fail-closed by construction: any malformed, missing, extra-shaped, or
 * hostile value yields `ask` (escalate), never `allow`. Only an explicit,
 * well-formed `allow` allows. This is the structural guard that keeps a broken
 * or adversarial hook from defaulting the tool call open.
 */
function parsePreToolHookDecision(stdout: string): PreToolHookDecision {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) {
    return { kind: "ask", reason: "pre-tool hook produced no decision output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return { kind: "ask", reason: "pre-tool hook decision was not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || !("decision" in parsed)) {
    return { kind: "ask", reason: "pre-tool hook decision missing \"decision\" field" };
  }

  const decision = (parsed as { readonly decision?: unknown }).decision;
  switch (decision) {
    case "allow":
      return PRE_TOOL_DECISION_ALLOW;
    case "ask": {
      const reason = (parsed as { readonly reason?: unknown }).reason;
      return { kind: "ask", reason: typeof reason === "string" && reason.length > 0 ? reason : "pre-tool hook asked" };
    }
    case "deny": {
      const reason = (parsed as { readonly reason?: unknown }).reason;
      return { kind: "deny", reason: typeof reason === "string" && reason.length > 0 ? reason : "pre-tool hook denied" };
    }
    case "updatedInput": {
      if (!("input" in parsed)) {
        return { kind: "ask", reason: "updatedInput decision missing \"input\" field" };
      }
      return { kind: "updatedInput", input: (parsed as { readonly input?: unknown }).input };
    }
    default:
      return { kind: "ask", reason: "pre-tool hook returned an unknown decision" };
  }
}

/**
 * Execute one deciding shell hook and return its decision. Separated from the
 * observer `runHook` path: the deciding lane captures stdout and awaits a
 * result; the observer lane never does, which is what makes observer hooks
 * structurally unable to rewrite. Any execution failure (spawn error, non-zero
 * exit, timeout, oversize output) resolves to a fail-closed `ask`.
 */
function runDecidingHook(invocation: HookInvocation, envPayload: Record<string, string>): Promise<PreToolHookDecision> {
  return new Promise((resolve) => {
    execFile(
      invocation.file,
      [...invocation.args],
      {
        env: { ...process.env, ...envPayload },
        timeout: PRE_TOOL_HOOK_TIMEOUT_MS,
        maxBuffer: PRE_TOOL_HOOK_MAX_BUFFER
      },
      (error, stdout) => {
        if (error) {
          resolve({ kind: "ask", reason: `pre-tool hook failed: ${error.message}` });
          return;
        }
        try {
          resolve(parsePreToolHookDecision(typeof stdout === "string" ? stdout : String(stdout)));
        } catch {
          resolve({ kind: "ask", reason: "pre-tool hook decision could not be interpreted" });
        }
      }
    );
  });
}

/**
 * The deciding pre-tool hook registry. Kept here (not on the observer event bus)
 * so the deciding lane and the observer lane are disjoint by construction: an
 * extension that wants to DECIDE registers a `PreToolHook`; an extension on the
 * `on()` bus can only observe. Process-external deciding shell hooks are added
 * by `registerShellHooks` below and evaluated through the same registry, so one
 * merge path governs both in-process and shell hooks.
 */
const preToolHooks: PreToolHook[] = [];

/** Register a deciding in-process pre-tool hook. Returns an unregister fn. */
export function registerPreToolHook(hook: PreToolHook): () => void {
  preToolHooks.push(hook);
  return () => {
    const index = preToolHooks.indexOf(hook);
    if (index >= 0) preToolHooks.splice(index, 1);
  };
}

/** Test seam: drop all registered deciding hooks. Not for production paths. */
export function clearPreToolHooks(): void {
  preToolHooks.length = 0;
}

/**
 * Evaluate every deciding pre-tool hook for a tool call and merge to ONE
 * decision via `mergePreToolHookDecisions` (deny > ask > last-updatedInput >
 * allow). Order: in-process deciding hooks first (registration order), then the
 * project shell hook if the project is trusted. A hook that throws is treated
 * as a fail-closed `ask` for that hook alone and does not stop later hooks —
 * but note the merge still cannot be lifted back to allow by anything after it.
 *
 * This function runs BEFORE soft policy by contract of its caller; it never
 * executes the tool and never touches the mandate floor — it only produces a
 * decision the caller applies ahead of (never instead of) mandate evaluation.
 */
export async function evaluatePreToolHooks(toolId: string, input: unknown): Promise<PreToolHookDecision> {
  const decisions: PreToolHookDecision[] = [];

  for (const hook of [...preToolHooks]) {
    const invocation: PreToolHookInvocation = { hookId: hook.name || "anonymous", toolId, input };
    try {
      decisions.push(await hook(invocation));
    } catch {
      decisions.push({ kind: "ask", reason: "pre-tool hook threw during evaluation" });
    }
  }

  if (isProjectHookTrusted()) {
    const script = getHookScript("tool-pre");
    if (script) {
      const envPayload: Record<string, string> = {
        GURU_TOOL_ID: toolId,
        GURU_TOOL_INPUT: typeof input === "string" ? input : serializeToolResult(input)
      };
      decisions.push(await runDecidingHook(script, envPayload));
    }
  }

  return mergePreToolHookDecisions(decisions);
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
