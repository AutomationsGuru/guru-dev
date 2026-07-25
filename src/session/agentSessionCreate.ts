import { randomUUID } from "node:crypto";

import type { ChatTurnMessage } from "../model/directChat.js";

/**
 * Agent session create (IDEA-F259-AGENT-SESSION-01, R-MA-SESSION).
 *
 * A pure factory for the smallest honest "an agent session exists" value:
 * a fresh unique session id, an empty transcript history, and the default
 * shell backend — `local`, matching the harness's owned-runtime posture
 * (a hosted backend is an explicit ATTACH, never the silent default; see
 * F243 shell-backend selector / F252 hosted shell stub, which fail closed
 * until one is wired).
 *
 * No I/O, no runtime bootstrap, no MAF rehost. Composing surfaces (RPC
 * `createAgentSession`, the TUI, tests) use this to stamp out a session
 * record before any turn runs. Composes with F114 conversation + F174
 * identity work.
 */

/** The default shell backend id: exec happens in the local workspace. */
export const AGENT_SESSION_SHELL_LOCAL = "local" as const;

/**
 * Known shell backend ids. The union stays open (`string & {}`) so an
 * ATTACHed backend id (e.g. a future hosted provider) type-checks without
 * editing this core file — extension through the seam, not core churn.
 */
export type AgentSessionShellBackend = typeof AGENT_SESSION_SHELL_LOCAL | "hosted" | (string & {});

export interface AgentSessionCreateOptions {
  /** Explicit session id (deterministic tests, resumed sessions). Default: a fresh UUID. */
  readonly id?: string;
  /** Shell backend id. Default: `local` — never a hosted/provider default. */
  readonly shellBackend?: AgentSessionShellBackend;
}

export interface CreatedAgentSession {
  /** Unique session identifier. */
  readonly id: string;
  /** Empty transcript history — per-session, never shared between instances. */
  readonly history: ChatTurnMessage[];
  /** The shell backend this session executes against. */
  readonly shellBackend: AgentSessionShellBackend;
}

/**
 * Create a new agent session record: unique id + empty history + default
 * `local` shell backend. Pure and synchronous; repeated calls never reuse
 * an id and never share the history array.
 */
export function agentSessionCreate(options: AgentSessionCreateOptions = {}): CreatedAgentSession {
  return {
    id: options.id ?? randomUUID(),
    history: [],
    shellBackend: options.shellBackend ?? AGENT_SESSION_SHELL_LOCAL
  };
}
