import { resolve } from "node:path";

/**
 * IDEA-D2 live workspace bus.
 *
 * One process-local bus keys live headless-API state by workspace. The workspace
 * key is the **resolved cwd** of the work (request `cwd` when supplied, else the
 * API process cwd) — the same cwd the runtime session starts in, resolved
 * lexically with `node:path.resolve` so `/repo`, `/repo/`, and `/repo/nested/..`
 * share one workspace.
 *
 * Tracked per workspace:
 *   - `attachedClients` — live attachments (SSE event-stream connections). The
 *     bus is transport-neutral: `attach()` returns a handle whose `detach()` is
 *     idempotent, so an aborted connection never leaks a count.
 *   - `isBusy` — reference-counted over active session ids. Session start marks
 *     busy; a terminal signal (explicit finish, or a `done.packet` /
 *     `operator.recovery` timeline event) releases that session's hold.
 *
 * Multi-attach flag precedence (plan step 3, documented): **first-wins**. The
 * first client to attach to a workspace claims the `yolo`/`debug` flags; later
 * attachments report the established flags and the owning client id instead of
 * overriding them. Ownership is released only when the owning attachment
 * detaches. Flags are advisory signals for observers — no mandate or permission
 * state reads this bus, so a later client can never weaken a hard limit by
 * attaching.
 */
export const WORKSPACE_FLAG_PRECEDENCE_NOTE =
  "Multi-attach flag precedence is first-wins: the first client to attach to a workspace claims the yolo/debug flags and later attachments observe them without overriding. The claim releases when the first client detaches.";

export type WorkspaceFlagPrecedence = "first-wins";

/** Timeline event types that hold the busy signal until a terminal signal. */
export const DEFAULT_WORKSPACE_BUSY_EVENT_TYPES = Object.freeze(["run.progress", "planner.run"] as const);

/** Timeline event types that release a session's busy hold. */
const WORKSPACE_IDLE_EVENT_TYPES = new Set(["done.packet", "operator.recovery"]);

export interface WorkspaceFlags {
  readonly yolo: boolean;
  readonly debug: boolean;
}

export interface WorkspaceSummary {
  readonly workspaceKey: string;
  readonly attachedClients: number;
  readonly isBusy: boolean;
}

export interface WorkspaceInfo extends WorkspaceSummary {
  readonly flags: WorkspaceFlags;
  readonly flagOwnerClientId?: string;
  readonly precedence: WorkspaceFlagPrecedence;
  readonly precedenceNote: string;
}

export interface WorkspaceAttachOptions {
  /** Work cwd; defaults to the bus cwd (the API process cwd). */
  readonly cwd?: string;
  readonly clientId?: string;
  readonly flags?: { readonly yolo?: boolean; readonly debug?: boolean };
}

export interface WorkspaceAttachment {
  readonly clientId: string;
  /** Effective workspace flags after first-wins precedence is applied. */
  readonly flags: WorkspaceFlags;
  /** The client currently holding the first-wins flag claim (undefined until claimed). */
  readonly flagOwnerClientId: string | undefined;
  readonly workspace: WorkspaceInfo;
  /** Idempotent: detaching twice releases the client count exactly once. */
  detach(): void;
}

export type WorkspaceBusEvent =
  | { readonly type: "workspace.attach"; readonly workspaceKey: string; readonly clientId: string; readonly workspace: WorkspaceSummary }
  | { readonly type: "workspace.detach"; readonly workspaceKey: string; readonly clientId: string; readonly workspace: WorkspaceSummary }
  | {
      readonly type: "workspace.flags";
      readonly workspaceKey: string;
      readonly clientId: string;
      readonly flags: WorkspaceFlags;
      readonly precedence: WorkspaceFlagPrecedence;
      readonly workspace: WorkspaceSummary;
    }
  | { readonly type: "session.started"; readonly workspaceKey: string; readonly sessionId: string; readonly workspace: WorkspaceSummary }
  | { readonly type: "session.busy"; readonly workspaceKey: string; readonly sessionId: string; readonly workspace: WorkspaceSummary }
  | { readonly type: "session.idle"; readonly workspaceKey: string; readonly sessionId: string; readonly workspace: WorkspaceSummary };

export type WorkspaceBusListener = (event: WorkspaceBusEvent) => void;

export interface WorkspaceBusOptions {
  /** Fallback cwd for notes/attaches that do not name one; defaults to process.cwd(). */
  readonly cwd?: string;
  /** Timeline event types that mark a session busy; defaults to DEFAULT_WORKSPACE_BUSY_EVENT_TYPES. */
  readonly busyEventTypes?: readonly string[];
  readonly clientIdFactory?: () => string;
}

export interface WorkspaceBus {
  attach(options?: WorkspaceAttachOptions): WorkspaceAttachment;
  noteSessionStarted(note: { readonly sessionId: string; readonly cwd?: string }): void;
  noteSessionFinished(note: { readonly sessionId: string }): void;
  noteTimelineEvent(note: { readonly sessionId: string; readonly type: string; readonly cwd?: string }): void;
  workspace(cwd?: string): WorkspaceInfo | undefined;
  snapshot(): readonly WorkspaceSummary[];
  subscribe(listener: WorkspaceBusListener): () => void;
  close(): void;
}

interface WorkspaceState {
  readonly key: string;
  clients: number;
  readonly busySessions: Set<string>;
  flags: WorkspaceFlags;
  flagOwnerClientId: string | undefined;
}

const DEFAULT_FLAGS: WorkspaceFlags = { yolo: false, debug: false };

let fallbackClientSequence = 0;

export function createWorkspaceBus(options: WorkspaceBusOptions = {}): WorkspaceBus {
  const defaultCwd = options.cwd ?? process.cwd();
  const busyEventTypes = new Set(options.busyEventTypes ?? DEFAULT_WORKSPACE_BUSY_EVENT_TYPES);
  const clientIdFactory = options.clientIdFactory ?? (() => `client-${(fallbackClientSequence += 1)}`);
  const workspaces = new Map<string, WorkspaceState>();
  const sessionWorkspaces = new Map<string, WorkspaceState>();
  const listeners = new Set<WorkspaceBusListener>();
  let closed = false;

  function workspaceState(cwd?: string): WorkspaceState {
    const key = resolve(cwd ?? defaultCwd);
    let state = workspaces.get(key);
    if (!state) {
      state = { key, clients: 0, busySessions: new Set(), flags: { ...DEFAULT_FLAGS }, flagOwnerClientId: undefined };
      workspaces.set(key, state);
    }
    return state;
  }

  function summarize(state: WorkspaceState): WorkspaceSummary {
    return { workspaceKey: state.key, attachedClients: state.clients, isBusy: state.busySessions.size > 0 };
  }

  function info(state: WorkspaceState): WorkspaceInfo {
    return {
      ...summarize(state),
      flags: { ...state.flags },
      ...(state.flagOwnerClientId !== undefined ? { flagOwnerClientId: state.flagOwnerClientId } : {}),
      precedence: "first-wins",
      precedenceNote: WORKSPACE_FLAG_PRECEDENCE_NOTE
    };
  }

  function emit(event: WorkspaceBusEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty observer must never break workspace tracking or other listeners.
      }
    }
  }

  function markBusy(state: WorkspaceState, sessionId: string, type: "session.started" | "session.busy"): void {
    if (state.busySessions.has(sessionId)) {
      return;
    }
    state.busySessions.add(sessionId);
    sessionWorkspaces.set(sessionId, state);
    emit({ type, workspaceKey: state.key, sessionId, workspace: summarize(state) });
  }

  function releaseBusy(state: WorkspaceState, sessionId: string): void {
    if (!state.busySessions.delete(sessionId)) {
      return;
    }
    sessionWorkspaces.delete(sessionId);
    emit({ type: "session.idle", workspaceKey: state.key, sessionId, workspace: summarize(state) });
  }

  return {
    attach(attachOptions = {}) {
      if (closed) {
        throw new Error("Workspace bus is closed.");
      }

      const state = workspaceState(attachOptions.cwd);
      const clientId = attachOptions.clientId ?? clientIdFactory();
      state.clients += 1;

      let claimedFlags = false;
      if (state.flagOwnerClientId === undefined) {
        // First-wins: this attachment establishes the workspace flags.
        state.flags = {
          yolo: attachOptions.flags?.yolo ?? DEFAULT_FLAGS.yolo,
          debug: attachOptions.flags?.debug ?? DEFAULT_FLAGS.debug
        };
        state.flagOwnerClientId = clientId;
        claimedFlags = true;
      }

      emit({ type: "workspace.attach", workspaceKey: state.key, clientId, workspace: summarize(state) });
      if (claimedFlags) {
        emit({
          type: "workspace.flags",
          workspaceKey: state.key,
          clientId,
          flags: { ...state.flags },
          precedence: "first-wins",
          workspace: summarize(state)
        });
      }

      let detached = false;
      return {
        clientId,
        get flags() {
          return { ...state.flags };
        },
        get flagOwnerClientId() {
          return state.flagOwnerClientId;
        },
        get workspace() {
          return info(state);
        },
        detach() {
          if (detached) {
            return;
          }
          detached = true;
          state.clients = Math.max(0, state.clients - 1);
          if (state.flagOwnerClientId === clientId) {
            // Release the first-wins claim; flags persist until a new claimant.
            state.flagOwnerClientId = undefined;
          }
          emit({ type: "workspace.detach", workspaceKey: state.key, clientId, workspace: summarize(state) });
        }
      };
    },

    noteSessionStarted(note) {
      if (closed) {
        return;
      }
      markBusy(workspaceState(note.cwd), note.sessionId, "session.started");
    },

    noteSessionFinished(note) {
      const state = sessionWorkspaces.get(note.sessionId);
      if (state) {
        releaseBusy(state, note.sessionId);
      }
    },

    noteTimelineEvent(note) {
      if (closed) {
        return;
      }
      const known = sessionWorkspaces.get(note.sessionId);
      if (busyEventTypes.has(note.type)) {
        markBusy(known ?? workspaceState(note.cwd), note.sessionId, "session.busy");
      } else if (WORKSPACE_IDLE_EVENT_TYPES.has(note.type) && known) {
        releaseBusy(known, note.sessionId);
      }
    },

    workspace(cwd) {
      const key = resolve(cwd ?? defaultCwd);
      const state = workspaces.get(key);
      return state ? info(state) : undefined;
    },

    snapshot() {
      return [...workspaces.values()].map(summarize).sort((a, b) => a.workspaceKey.localeCompare(b.workspaceKey));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      listeners.clear();
      workspaces.clear();
      sessionWorkspaces.clear();
    }
  };
}
