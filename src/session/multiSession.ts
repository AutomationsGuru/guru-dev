/**
 * IDEA-C3 multi-session tracks (R-OC-MULTI / R-CR-SESS / R-CC-MULTI).
 *
 * Multiple named session tracks per project (workspace root) with list / create /
 * switch / rename and a structural busy signal, built on top of the existing
 * {@link SessionPersistenceStore} event timeline — no schema change, and the
 * single-session default is untouched: a runtime that never constructs this
 * registry behaves exactly as before, and every registry always contains the
 * implicit "default" track.
 *
 * Persistence: each mutation is recorded as a `run.progress` beacon at stage
 * `multi-session-track` under one deterministic registry session id derived from
 * the workspace root. The full payload rides in `metadata.track`, so hydration is
 * a single `listEvents` call that replays the fold. Unrelated sessions and
 * unrelated progress stages are never touched. A malformed registry event fails
 * closed ({@link MultiSessionTrackStateCorruptError}) instead of silently
 * dropping or inventing tracks.
 *
 * Busy rule (structural, not prose): while a track is marked busy — a turn is in
 * flight — {@link MultiSessionTrackRegistry.switchTrack} refuses to leave or enter
 * that track and throws {@link MultiSessionTrackBusyError}. This mirrors the
 * AgentSession turn guard ("session is busy; cannot switch routes while a turn is
 * running."). Integrators (S1-A: src/guru.ts / src/runtime/session.ts) MUST clear
 * the flag in a `finally` when the turn settles so a crashed turn cannot wedge
 * the registry; the flag is observable via {@link MultiSessionTrackRegistry.isBusy}
 * and the `busy` field on every listed track.
 *
 * Scope: one registry instance per live runtime. No multi-client SSE workspace
 * bus (D2) and no cloud sync, per the plan's explicit exclusions.
 */

import { z } from "zod";

import type { SessionPersistenceStore } from "../runtime/persistence.js";

/** Name of the implicit per-workspace track every registry starts with. */
export const DEFAULT_TRACK_NAME = "default";
/** Deterministic id of the implicit default track. */
export const DEFAULT_TRACK_ID = "default";
/** run.progress stage that carries every track-registry event. */
export const MULTI_SESSION_TRACK_STAGE = "multi-session-track";
/** Maximum normalized track-name length. */
export const MAX_TRACK_NAME_LENGTH = 64;

/** Stable error codes; each is also a substring of the error message. */
export const MULTI_SESSION_TRACK_BUSY_ERROR = "multi-session-track-busy";
export const MULTI_SESSION_TRACK_NAME_TAKEN_ERROR = "multi-session-track-name-taken";
export const MULTI_SESSION_TRACK_NOT_FOUND_ERROR = "multi-session-track-not-found";
export const MULTI_SESSION_TRACK_STATE_CORRUPT_ERROR = "multi-session-track-state-corrupt";

const TrackNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TRACK_NAME_LENGTH);

const TrackRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    name: TrackNameSchema,
    sessionId: z.string().trim().min(1).nullable(),
    createdAt: z.string().datetime()
  })
  .strict();

const TrackEventPayloadSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("track.created"), track: TrackRecordSchema }).strict(),
    z.object({ type: z.literal("track.switched"), activeTrackId: z.string().trim().min(1) }).strict(),
    z.object({ type: z.literal("track.renamed"), trackId: z.string().trim().min(1), name: TrackNameSchema }).strict(),
    z.object({ type: z.literal("track.busy"), trackId: z.string().trim().min(1), busy: z.boolean() }).strict()
  ]);
export type MultiSessionTrackEventPayload = z.infer<typeof TrackEventPayloadSchema>;

/** Public snapshot of one session track. */
export interface MultiSessionTrackInfo {
  readonly id: string;
  readonly name: string;
  readonly workspaceRoot: string;
  /** Harness session id bound to this track; null until the integrator binds one. */
  readonly sessionId: string | null;
  readonly createdAt: string;
  /** True while a turn is in flight on this track — switching is structurally blocked. */
  readonly busy: boolean;
  /** True for the track switch/resume currently targets. */
  readonly active: boolean;
  /** True only for the implicit "default" track (cannot be renamed). */
  readonly isDefault: boolean;
}

/** Result of a successful switch: the now-active track plus where we came from. */
export interface MultiSessionSwitchResult extends MultiSessionTrackInfo {
  readonly previous: { readonly id: string; readonly name: string } | null;
}

export interface MultiSessionTrackRegistryDeps {
  /** Exact workspace root this registry is scoped to. Tracks never leak across roots. */
  readonly workspaceRoot: string;
  /** Existing session persistence timeline; the only store this module writes to. */
  readonly store: SessionPersistenceStore;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export interface MultiSessionTrackRegistry {
  listTracks(): Promise<readonly MultiSessionTrackInfo[]>;
  getTrack(nameOrId: string): Promise<MultiSessionTrackInfo | undefined>;
  getActiveTrack(): Promise<MultiSessionTrackInfo | undefined>;
  createTrack(name: string, sessionId: string): Promise<MultiSessionTrackInfo>;
  switchTrack(nameOrId: string): Promise<MultiSessionSwitchResult>;
  renameTrack(nameOrId: string, nextName: string): Promise<MultiSessionTrackInfo>;
  setBusy(nameOrId: string, busy: boolean): Promise<MultiSessionTrackInfo>;
  /** Synchronous read of the last-hydrated busy flag (unknown track → not-found). */
  isBusy(nameOrId: string): boolean;
}

/** Switching to or from a track with a turn in flight is refused structurally. */
export class MultiSessionTrackBusyError extends Error {
  readonly code = MULTI_SESSION_TRACK_BUSY_ERROR;
  constructor(trackName: string) {
    super(
      `[${MULTI_SESSION_TRACK_BUSY_ERROR}] Session track "${trackName}" is busy; a turn is in flight. ` +
        "Wait for the turn to finish (or cancel it) before switching session tracks."
    );
    this.name = "MultiSessionTrackBusyError";
  }
}

/** A create/rename collided with an existing track name in this workspace. */
export class MultiSessionTrackNameTakenError extends Error {
  readonly code = MULTI_SESSION_TRACK_NAME_TAKEN_ERROR;
  constructor(trackName: string) {
    super(`[${MULTI_SESSION_TRACK_NAME_TAKEN_ERROR}] Session track name "${trackName}" already exists in this workspace.`);
    this.name = "MultiSessionTrackNameTakenError";
  }
}

/** No track with the given name/id exists in this workspace. */
export class MultiSessionTrackNotFoundError extends Error {
  readonly code = MULTI_SESSION_TRACK_NOT_FOUND_ERROR;
  constructor(nameOrId: string) {
    super(`[${MULTI_SESSION_TRACK_NOT_FOUND_ERROR}] Session track not found in this workspace: ${nameOrId}`);
    this.name = "MultiSessionTrackNotFoundError";
  }
}

/** The persisted fold is malformed — fail closed rather than guess at state. */
export class MultiSessionTrackStateCorruptError extends Error {
  readonly code = MULTI_SESSION_TRACK_STATE_CORRUPT_ERROR;
  constructor(detail: string) {
    super(`[${MULTI_SESSION_TRACK_STATE_CORRUPT_ERROR}] Multi-session track state is corrupt: ${detail}`);
    this.name = "MultiSessionTrackStateCorruptError";
  }
}

/** Trim edges and collapse internal whitespace so "a  b" and " a b " are one name. */
export function normalizeTrackName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Deterministic persistence owner for one workspace's track-registry events. */
export function multiSessionTrackRegistrySessionId(workspaceRoot: string): string {
  return `multi-session-track-registry:${workspaceRoot}`;
}

interface MutableTrack {
  id: string;
  name: string;
  sessionId: string | null;
  createdAt: string;
  busy: boolean;
  isDefault: boolean;
}

interface RegistryState {
  /** Creation order; the default track is always first. */
  readonly order: string[];
  readonly byId: Map<string, MutableTrack>;
  activeTrackId: string;
}

export function createMultiSessionTrackRegistry(deps: MultiSessionTrackRegistryDeps): MultiSessionTrackRegistry {
  const workspaceRoot = deps.workspaceRoot?.trim();
  if (!workspaceRoot) {
    throw new Error("createMultiSessionTrackRegistry: workspaceRoot must be a non-empty string.");
  }
  const now = deps.now ?? (() => new Date());
  const registrySessionId = multiSessionTrackRegistrySessionId(workspaceRoot);

  let state: RegistryState | undefined;
  let hydration: Promise<RegistryState> | undefined;

  function freshState(): RegistryState {
    const defaultTrack: MutableTrack = {
      id: DEFAULT_TRACK_ID,
      name: DEFAULT_TRACK_NAME,
      sessionId: null,
      createdAt: now().toISOString(),
      busy: false,
      isDefault: true
    };
    return { order: [defaultTrack.id], byId: new Map([[defaultTrack.id, defaultTrack]]), activeTrackId: DEFAULT_TRACK_ID };
  }

  async function hydrate(): Promise<RegistryState> {
    if (state) {
      return state;
    }
    hydration ??= (async () => {
      const folded = freshState();
      const events = await deps.store.listEvents(registrySessionId);
      for (const event of events) {
        if (event.type !== "run.progress") {
          continue;
        }
        const metadata = (event.payload as { metadata?: unknown } | undefined)?.metadata;
        const trackPayload = (metadata as { track?: unknown } | undefined)?.track;
        if (trackPayload === undefined) {
          continue; // an unrelated beacon that happens to share the id prefix — not ours.
        }
        applyEvent(folded, trackPayload);
      }
      state = folded;
      return folded;
    })();
    try {
      return await hydration;
    } catch (error) {
      hydration = undefined; // a failed hydrate must not poison later retries.
      throw error;
    }
  }

  function applyEvent(target: RegistryState, rawPayload: unknown): void {
    const parsed = TrackEventPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new MultiSessionTrackStateCorruptError(`unparseable track event payload (${parsed.error.issues[0]?.message ?? "unknown issue"}).`);
    }
    const payload = parsed.data;
    switch (payload.type) {
      case "track.created": {
        if (target.byId.has(payload.track.id)) {
          throw new MultiSessionTrackStateCorruptError(`duplicate track id "${payload.track.id}".`);
        }
        if (findByName(target, payload.track.name)) {
          throw new MultiSessionTrackStateCorruptError(`duplicate track name "${payload.track.name}".`);
        }
        target.byId.set(payload.track.id, { ...payload.track, busy: false, isDefault: false });
        target.order.push(payload.track.id);
        return;
      }
      case "track.switched": {
        requireTrack(target, payload.activeTrackId);
        target.activeTrackId = payload.activeTrackId;
        return;
      }
      case "track.renamed": {
        const track = requireTrack(target, payload.trackId);
        const collision = findByName(target, payload.name);
        if (collision && collision.id !== track.id) {
          throw new MultiSessionTrackStateCorruptError(`rename collides with existing track "${payload.name}".`);
        }
        track.name = payload.name;
        return;
      }
      case "track.busy": {
        requireTrack(target, payload.trackId).busy = payload.busy;
        return;
      }
    }
  }

  function requireTrack(target: RegistryState, nameOrId: string): MutableTrack {
    const track = target.byId.get(nameOrId) ?? findByName(target, normalizeTrackName(nameOrId));
    if (!track) {
      throw new MultiSessionTrackNotFoundError(nameOrId);
    }
    return track;
  }

  function findByName(target: RegistryState, normalizedName: string): MutableTrack | undefined {
    for (const id of target.order) {
      const track = target.byId.get(id);
      if (track && track.name === normalizedName) {
        return track;
      }
    }
    return undefined;
  }

  function snapshot(track: MutableTrack, activeTrackId: string): MultiSessionTrackInfo {
    return {
      id: track.id,
      name: track.name,
      workspaceRoot,
      sessionId: track.sessionId,
      createdAt: track.createdAt,
      busy: track.busy,
      active: track.id === activeTrackId,
      isDefault: track.isDefault
    };
  }

  async function persist(payload: MultiSessionTrackEventPayload, message: string): Promise<void> {
    await deps.store.recordRunProgress(registrySessionId, {
      stage: MULTI_SESSION_TRACK_STAGE,
      status: payload.type === "track.busy" && payload.busy ? "in_progress" : "completed",
      message,
      recordedAt: now().toISOString(),
      metadata: { workspaceRoot, track: payload }
    });
  }

  function assertNameAvailable(target: RegistryState, normalizedName: string): void {
    if (findByName(target, normalizedName)) {
      throw new MultiSessionTrackNameTakenError(normalizedName);
    }
  }

  function validateFreshName(name: string): string {
    const normalized = normalizeTrackName(name);
    if (normalized.length === 0) {
      throw new Error("Session track name is blank.");
    }
    if (normalized.length > MAX_TRACK_NAME_LENGTH) {
      throw new Error(`Session track name exceeds ${MAX_TRACK_NAME_LENGTH} characters.`);
    }
    return normalized;
  }

  return {
    async listTracks() {
      const current = await hydrate();
      return current.order.map((id) => snapshot(current.byId.get(id)!, current.activeTrackId));
    },

    async getTrack(nameOrId) {
      const current = await hydrate();
      const track = current.byId.get(nameOrId) ?? findByName(current, normalizeTrackName(nameOrId));
      return track ? snapshot(track, current.activeTrackId) : undefined;
    },

    async getActiveTrack() {
      const current = await hydrate();
      const track = current.byId.get(current.activeTrackId);
      return track ? snapshot(track, current.activeTrackId) : undefined;
    },

    async createTrack(name, sessionId) {
      const current = await hydrate();
      const normalized = validateFreshName(name);
      const trimmedSessionId = sessionId?.trim();
      if (!trimmedSessionId) {
        throw new Error("createTrack: sessionId must be a non-empty string.");
      }
      // Structural uniqueness: validate BEFORE persisting so a duplicate can
      // never reach the timeline (and a failed create emits no event).
      assertNameAvailable(current, normalized);

      const track: MutableTrack = {
        id: `track-${current.order.length}-${normalized}`.slice(0, 96),
        name: normalized,
        sessionId: trimmedSessionId,
        createdAt: now().toISOString(),
        busy: false,
        isDefault: false
      };
      let suffix = 0;
      while (current.byId.has(track.id)) {
        suffix += 1;
        track.id = `track-${current.order.length + suffix}-${normalized}`.slice(0, 96);
      }
      await persist({ type: "track.created", track: { id: track.id, name: track.name, sessionId: track.sessionId, createdAt: track.createdAt } }, `Session track created: ${track.name}.`);
      current.byId.set(track.id, track);
      current.order.push(track.id);
      return snapshot(track, current.activeTrackId);
    },

    async switchTrack(nameOrId) {
      const current = await hydrate();
      const target = requireTrack(current, nameOrId);
      const source = current.byId.get(current.activeTrackId)!;
      // Busy rule (structural): a turn in flight pins its track — leaving or
      // entering a busy track is refused before any state or persistence moves.
      if (source.busy) {
        throw new MultiSessionTrackBusyError(source.name);
      }
      if (target.busy) {
        throw new MultiSessionTrackBusyError(target.name);
      }
      const previous = { id: source.id, name: source.name };
      if (target.id !== source.id) {
        await persist({ type: "track.switched", activeTrackId: target.id }, `Session track switched: ${source.name} -> ${target.name}.`);
        current.activeTrackId = target.id;
      }
      return { ...snapshot(target, current.activeTrackId), previous };
    },

    async renameTrack(nameOrId, nextName) {
      const current = await hydrate();
      const track = requireTrack(current, nameOrId);
      if (track.isDefault) {
        throw new Error("The default session track cannot be renamed.");
      }
      const normalized = validateFreshName(nextName);
      if (normalized === track.name) {
        return snapshot(track, current.activeTrackId);
      }
      // Validate before persisting — a failed rename never reaches the timeline.
      assertNameAvailable(current, normalized);
      await persist({ type: "track.renamed", trackId: track.id, name: normalized }, `Session track renamed: ${track.name} -> ${normalized}.`);
      track.name = normalized;
      return snapshot(track, current.activeTrackId);
    },

    async setBusy(nameOrId, busy) {
      const current = await hydrate();
      const track = requireTrack(current, nameOrId);
      if (track.busy === busy) {
        return snapshot(track, current.activeTrackId);
      }
      await persist(
        { type: "track.busy", trackId: track.id, busy },
        busy ? `Session track busy: ${track.name} (turn in flight).` : `Session track idle: ${track.name} (turn settled).`
      );
      track.busy = busy;
      return snapshot(track, current.activeTrackId);
    },

    isBusy(nameOrId) {
      const current = state;
      if (!current) {
        throw new MultiSessionTrackStateCorruptError("isBusy called before the registry was hydrated; await any registry method first.");
      }
      return requireTrack(current, nameOrId).busy;
    }
  };
}
