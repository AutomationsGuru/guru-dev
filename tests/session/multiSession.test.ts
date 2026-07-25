import { describe, expect, it } from "vitest";

import { createInMemorySessionPersistenceStore } from '../../src/runtime/persistence.js';
import {
  DEFAULT_TRACK_NAME,
  MULTI_SESSION_TRACK_BUSY_ERROR,
  MULTI_SESSION_TRACK_NAME_TAKEN_ERROR,
  MULTI_SESSION_TRACK_NOT_FOUND_ERROR,
  MULTI_SESSION_TRACK_STATE_CORRUPT_ERROR,
  MultiSessionTrackBusyError,
  MultiSessionTrackNameTakenError,
  MultiSessionTrackNotFoundError,
  MultiSessionTrackStateCorruptError,
  createMultiSessionTrackRegistry,
  multiSessionTrackRegistrySessionId,
  normalizeTrackName
} from '../../src/session/multiSession.js';

const ROOT_A = "/repo/alpha";
const ROOT_B = "/repo/beta";

function makeRegistry(now: () => Date = () => new Date(Date.UTC(2026, 6, 18, 12, 0, 0))) {
  const store = createInMemorySessionPersistenceStore();
  const registry = createMultiSessionTrackRegistry({ workspaceRoot: ROOT_A, store, now });
  return { store, registry };
}

describe("normalizeTrackName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeTrackName("  research   branch  ")).toBe("research branch");
  });
});

describe("multiSessionTrackRegistry — workspace scoping", () => {
  it("scopes tracks by exact workspace root; other roots are invisible", async () => {
    const { store, registry } = makeRegistry();
    await registry.createTrack("shared-name", "session-a");
    const other = createMultiSessionTrackRegistry({ workspaceRoot: ROOT_B, store });

    expect(await other.getTrack("shared-name")).toBeUndefined();
    expect((await registry.getTrack("shared-name"))?.name).toBe("shared-name");
    // Distinct roots may reuse the same track name without collision.
    const created = await other.createTrack("shared-name", "session-b");
    expect(created.sessionId).toBe("session-b");
    expect((await other.getTrack("shared-name"))?.sessionId).toBe("session-b");
    expect((await registry.getTrack("shared-name"))?.sessionId).toBe("session-a");
  });

  it("rejects a blank workspace root at construction", () => {
    expect(() => createMultiSessionTrackRegistry({ workspaceRoot: "   ", store: createInMemorySessionPersistenceStore() })).toThrow(
      /workspaceRoot/
    );
  });
});

describe("multiSessionTrackRegistry — create/list/switch", () => {
  it("creates named tracks and lists them in insertion order with the active flag", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("alpha", "session-1");
    await registry.createTrack("beta", "session-2");

    const tracks = await registry.listTracks();
    expect(tracks.map((track) => track.name)).toEqual([DEFAULT_TRACK_NAME, "alpha", "beta"]);
    expect(tracks.find((track) => track.name === "alpha")).toMatchObject({
      workspaceRoot: ROOT_A,
      sessionId: "session-1",
      busy: false,
      isDefault: false
    });
    // Nothing switched yet: the default track remains the active track.
    expect(tracks.find((track) => track.isDefault)?.active).toBe(true);
    expect(tracks.find((track) => track.name === "alpha")?.active).toBe(false);
  });

  it("returns a defensive copy from listTracks", async () => {
    const { registry } = makeRegistry();
    const tracks = await registry.listTracks();
    (tracks[0] as { name: string }).name = "mutated";
    expect((await registry.listTracks())[0]?.name).toBe(DEFAULT_TRACK_NAME);
  });

  it("switches the active track by name and reports the previous track", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("beta", "session-2");

    const active = await registry.switchTrack("beta");
    expect(active.name).toBe("beta");
    expect(active.previous?.name).toBe(DEFAULT_TRACK_NAME);
    expect(active.sessionId).toBe("session-2");
    expect((await registry.getActiveTrack())?.name).toBe("beta");
    expect((await registry.listTracks()).find((track) => track.name === DEFAULT_TRACK_NAME)?.active).toBe(false);
  });

  it("switching to the already-active track is a no-op that reports itself as previous", async () => {
    const { registry } = makeRegistry();
    const active = await registry.switchTrack(DEFAULT_TRACK_NAME);
    expect(active.name).toBe(DEFAULT_TRACK_NAME);
    expect(active.previous?.name).toBe(DEFAULT_TRACK_NAME);
  });

  it("switch accepts a track id as well as a name", async () => {
    const { registry } = makeRegistry();
    const created = await registry.createTrack("beta", "session-2");
    const active = await registry.switchTrack(created.id);
    expect(active.name).toBe("beta");
  });

  it("throws MultiSessionTrackNotFoundError when switching to an unknown track", async () => {
    const { registry } = makeRegistry();
    await expect(registry.switchTrack("ghost")).rejects.toThrowError(MultiSessionTrackNotFoundError);
    await expect(registry.switchTrack("ghost")).rejects.toThrowError(MULTI_SESSION_TRACK_NOT_FOUND_ERROR);
  });
});

describe("multiSessionTrackRegistry — rename", () => {
  it("renames a non-default track and preserves session binding", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("old", "session-1");
    const renamed = await registry.renameTrack("old", "new");

    expect(renamed.name).toBe("new");
    expect(renamed.sessionId).toBe("session-1");
    expect(await registry.getTrack("old")).toBeUndefined();
    expect((await registry.getTrack("new"))?.sessionId).toBe("session-1");
  });

  it("refuses to rename the default track or to a taken name", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("taken", "session-1");

    await expect(registry.renameTrack(DEFAULT_TRACK_NAME, "anything")).rejects.toThrowError(/default/);
    await expect(registry.renameTrack("taken", DEFAULT_TRACK_NAME)).rejects.toThrowError(MultiSessionTrackNameTakenError);
    await expect(registry.renameTrack("ghost", "fresh")).rejects.toThrowError(MultiSessionTrackNotFoundError);
  });

  it("renaming to the same normalized name is a no-op", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("keep", "session-1");
    const renamed = await registry.renameTrack("keep", "  keep  ");
    expect(renamed.name).toBe("keep");
  });
});

describe("multiSessionTrackRegistry — busy signal (structural switch block)", () => {
  it("blocks switching away from a busy track with the busy error and message", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("beta", "session-2");
    await registry.setBusy(DEFAULT_TRACK_NAME, true);

    expect(registry.isBusy(DEFAULT_TRACK_NAME)).toBe(true);
    await expect(registry.switchTrack("beta")).rejects.toThrowError(MultiSessionTrackBusyError);
    await expect(registry.switchTrack("beta")).rejects.toThrowError(MULTI_SESSION_TRACK_BUSY_ERROR);
    // The active track did not change.
    expect((await registry.getActiveTrack())?.name).toBe(DEFAULT_TRACK_NAME);
  });

  it("blocks switching TO a busy track as well", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("beta", "session-2");
    await registry.setBusy("beta", true);

    await expect(registry.switchTrack("beta")).rejects.toThrowError(MultiSessionTrackBusyError);
  });

  it("clearing the busy flag restores switching", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("beta", "session-2");
    await registry.setBusy(DEFAULT_TRACK_NAME, true);
    await registry.setBusy(DEFAULT_TRACK_NAME, false);

    const active = await registry.switchTrack("beta");
    expect(active.name).toBe("beta");
  });

  it("setBusy on an unknown track throws not-found", async () => {
    const { registry } = makeRegistry();
    await expect(registry.setBusy("ghost", true)).rejects.toThrowError(MultiSessionTrackNotFoundError);
  });
});

describe("multiSessionTrackRegistry — name enforcement", () => {
  it("rejects blank and over-long names", async () => {
    const { registry } = makeRegistry();
    await expect(registry.createTrack("   ", "s")).rejects.toThrowError(/blank/);
    await expect(registry.createTrack("x".repeat(65), "s")).rejects.toThrowError(/64/);
  });

  it("rejects duplicate names under normalization (trim/collapse) with the taken error", async () => {
    const { registry } = makeRegistry();
    await registry.createTrack("research branch", "session-1");

    await expect(registry.createTrack("  research   branch ", "session-2")).rejects.toThrowError(MultiSessionTrackNameTakenError);
    await expect(registry.createTrack("research branch", "session-2")).rejects.toThrowError(MULTI_SESSION_TRACK_NAME_TAKEN_ERROR);
  });

  it("createTrack returns the created track with the normalized name", async () => {
    const { registry } = makeRegistry();
    const created = await registry.createTrack("  spaced   out ", "session-1");
    expect(created.name).toBe("spaced out");
    expect(created.workspaceRoot).toBe(ROOT_A);
  });
});

describe("multiSessionTrackRegistry — persistence through the session store", () => {
  it("persists tracks so a fresh registry instance rehydrates them", async () => {
    const { store, registry } = makeRegistry();
    await registry.createTrack("beta", "session-2");
    await registry.switchTrack("beta");
    await registry.setBusy("beta", true);

    const rehydrated = createMultiSessionTrackRegistry({ workspaceRoot: ROOT_A, store });
    const tracks = await rehydrated.listTracks();
    expect(tracks.map((track) => track.name)).toEqual([DEFAULT_TRACK_NAME, "beta"]);
    expect(tracks.find((track) => track.name === "beta")).toMatchObject({ active: true, busy: true, sessionId: "session-2" });
  });

  it("never emits an event for a failed (duplicate) create", async () => {
    const { store, registry } = makeRegistry();
    await registry.createTrack("beta", "session-2");
    const before = (await store.listSessions({ limit: 100 })).length;
    await expect(registry.createTrack("beta", "session-3")).rejects.toThrowError(MultiSessionTrackNameTakenError);
    const after = (await store.listSessions({ limit: 100 })).length;
    expect(after).toBe(before);
  });

  it("survives interleaved unrelated run.progress events from other stages", async () => {
    const { store, registry } = makeRegistry();
    await registry.createTrack("beta", "session-2");
    await store.recordRunProgress("some-session", {
      stage: "operator-recovery",
      status: "in_progress",
      message: "unrelated beacon",
      recordedAt: new Date(Date.UTC(2026, 6, 18, 12, 1, 0)).toISOString()
    });

    const rehydrated = createMultiSessionTrackRegistry({ workspaceRoot: ROOT_A, store });
    expect((await rehydrated.listTracks()).map((track) => track.name)).toEqual([DEFAULT_TRACK_NAME, "beta"]);
  });

  it("fails closed on a corrupt track-registry event", async () => {
    const { store, registry } = makeRegistry();
    await registry.createTrack("beta", "session-2");
    // Forge a corrupt registry event: present but unparsable track payload.
    await store.recordRunProgress(multiSessionTrackRegistrySessionId(ROOT_A), {
      stage: "multi-session-track",
      status: "in_progress",
      message: "corrupt",
      recordedAt: new Date(Date.UTC(2026, 6, 18, 12, 2, 0)).toISOString(),
      metadata: { track: { bogus: true } }
    });

    const rehydrated = createMultiSessionTrackRegistry({ workspaceRoot: ROOT_A, store });
    await expect(rehydrated.listTracks()).rejects.toThrowError(MultiSessionTrackStateCorruptError);
    await expect(rehydrated.listTracks()).rejects.toThrowError(MULTI_SESSION_TRACK_STATE_CORRUPT_ERROR);
  });
});
