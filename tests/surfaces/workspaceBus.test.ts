import {
  createWorkspaceBus,
  DEFAULT_WORKSPACE_BUSY_EVENT_TYPES,
  WORKSPACE_FLAG_PRECEDENCE_NOTE,
  type WorkspaceBusEvent,
  type WorkspaceFlagPrecedence
} from '../../src/surfaces/workspaceBus.js';

function collect(bus: ReturnType<typeof createWorkspaceBus>): WorkspaceBusEvent[] {
  const events: WorkspaceBusEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  return events;
}

describe("workspaceBus keying", () => {
  it("keys workspaces by resolved cwd and defaults to the process cwd", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    const events = collect(bus);

    bus.noteSessionStarted({ sessionId: "s-1" });
    bus.noteSessionStarted({ sessionId: "s-2", cwd: "/repo/nested/../" });

    expect(events).toEqual([
      {
        type: "session.started",
        workspaceKey: "/repo",
        sessionId: "s-1",
        workspace: { workspaceKey: "/repo", attachedClients: 0, isBusy: true }
      },
      {
        type: "session.started",
        workspaceKey: "/repo",
        sessionId: "s-2",
        workspace: { workspaceKey: "/repo", attachedClients: 0, isBusy: true }
      }
    ]);
  });

  it("separates workspaces for distinct cwds", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });

    bus.noteSessionStarted({ sessionId: "s-1" });
    bus.noteSessionStarted({ sessionId: "s-2", cwd: "/other" });

    expect(bus.snapshot()).toEqual([
      { workspaceKey: "/other", attachedClients: 0, isBusy: true },
      { workspaceKey: "/repo", attachedClients: 0, isBusy: true }
    ]);
  });
});

describe("workspaceBus busy tracking", () => {
  it("tracks busy across sessions with reference counting", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });

    bus.noteSessionStarted({ sessionId: "s-1" });
    bus.noteSessionStarted({ sessionId: "s-2" });
    bus.noteSessionFinished({ sessionId: "s-1" });
    expect(bus.workspace("/repo")?.isBusy).toBe(true);

    bus.noteSessionFinished({ sessionId: "s-2" });
    expect(bus.workspace("/repo")).toMatchObject({ workspaceKey: "/repo", attachedClients: 0, isBusy: false });
  });

  it("marks busy on configured lifecycle events and clears on terminal events", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    const events = collect(bus);

    bus.noteTimelineEvent({ sessionId: "s-1", type: "run.progress" });
    expect(bus.workspace("/repo")?.isBusy).toBe(true);

    bus.noteTimelineEvent({ sessionId: "s-1", type: "done.packet" });
    expect(bus.workspace("/repo")?.isBusy).toBe(false);

    const types = events.map((event) => event.type);
    expect(types).toEqual(["session.busy", "session.idle"]);
  });

  it("ignores timeline events outside the busy set and dedupes session ids", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });

    bus.noteTimelineEvent({ sessionId: "s-1", type: "tool.observation" });
    expect(bus.workspace("/repo")).toBeUndefined();

    bus.noteTimelineEvent({ sessionId: "s-1", type: "run.progress" });
    bus.noteTimelineEvent({ sessionId: "s-1", type: "run.progress" });
    bus.noteSessionFinished({ sessionId: "s-1" });
    expect(bus.workspace("/repo")?.isBusy).toBe(false);
  });

  it("honors an injected busy event-type set", () => {
    const bus = createWorkspaceBus({ cwd: "/repo", busyEventTypes: ["planner.run"] });

    bus.noteTimelineEvent({ sessionId: "s-1", type: "planner.run" });
    expect(bus.workspace("/repo")?.isBusy).toBe(true);
    bus.noteTimelineEvent({ sessionId: "s-1", type: "tool.observation" });
    expect(bus.workspace("/repo")?.isBusy).toBe(true);
    bus.noteSessionFinished({ sessionId: "s-1" });
    expect(bus.workspace("/repo")?.isBusy).toBe(false);
  });

  it("exposes the default busy event types as a frozen list", () => {
    expect(DEFAULT_WORKSPACE_BUSY_EVENT_TYPES).toEqual(["run.progress", "planner.run"]);
    expect(Object.isFrozen(DEFAULT_WORKSPACE_BUSY_EVENT_TYPES)).toBe(true);
  });

  it("finishing an unknown session is a no-op", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    const events = collect(bus);

    bus.noteSessionFinished({ sessionId: "missing" });

    expect(events).toEqual([]);
    expect(bus.snapshot()).toEqual([]);
  });
});

describe("workspaceBus attach tracking", () => {
  it("counts attached clients and emits workspace.attach events", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    const events = collect(bus);

    const first = bus.attach({ clientId: "cli-1" });
    expect(first.clientId).toBe("cli-1");
    expect(first.workspace).toMatchObject({ workspaceKey: "/repo", attachedClients: 1, isBusy: false });
    bus.attach({ clientId: "cli-2" });

    expect(bus.workspace("/repo")).toMatchObject({ workspaceKey: "/repo", attachedClients: 2, isBusy: false });
    expect(events.map((event) => event.type)).toEqual(["workspace.attach", "workspace.flags", "workspace.attach"]);
  });

  it("detaches exactly once per attachment and emits workspace.detach", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    const events = collect(bus);

    const attachment = bus.attach({ clientId: "cli-1" });
    attachment.detach();
    attachment.detach();

    expect(bus.workspace("/repo")?.attachedClients).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["workspace.attach", "workspace.flags", "workspace.detach"]);
    expect(events[2]).toMatchObject({ workspaceKey: "/repo", clientId: "cli-1" });
  });

  it("keeps workspaces without clients visible in the snapshot (isBusy signal survives detach)", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });

    bus.noteSessionStarted({ sessionId: "s-1" });
    const attachment = bus.attach({});
    attachment.detach();

    expect(bus.workspace("/repo")).toMatchObject({ workspaceKey: "/repo", attachedClients: 0, isBusy: true });
    expect(bus.snapshot()).toEqual([{ workspaceKey: "/repo", attachedClients: 0, isBusy: true }]);
  });

  it("supports attaching to an explicit workspace cwd", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });

    const attachment = bus.attach({ cwd: "/elsewhere" });

    expect(bus.workspace("/repo")).toBeUndefined();
    expect(bus.workspace("/elsewhere")?.attachedClients).toBe(1);
    attachment.detach();
    expect(bus.workspace("/elsewhere")?.attachedClients).toBe(0);
  });

  it("rejects attaching after close", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    bus.close();

    expect(() => bus.attach({})).toThrow(/closed/u);
  });
});

describe("workspaceBus flag precedence", () => {
  it("first-wins: the first attached client claims yolo/debug and later clients cannot change them", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    const events = collect(bus);

    const first = bus.attach({ clientId: "cli-1", flags: { yolo: true, debug: false } });
    expect(first.flags).toEqual({ yolo: true, debug: false });

    const second = bus.attach({ clientId: "cli-2", flags: { yolo: false, debug: true } });
    expect(second.flags).toEqual({ yolo: true, debug: false });
    expect(second.flagOwnerClientId).toBe("cli-1");

    const flagEvents = events.filter((event) => event.type === "workspace.flags");
    expect(flagEvents).toHaveLength(1);
    expect(flagEvents[0]).toMatchObject({
      workspaceKey: "/repo",
      clientId: "cli-1",
      flags: { yolo: true, debug: false },
      precedence: "first-wins"
    });
  });

  it("releases flag ownership when the first client detaches so the next attach claims the flags", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });

    const first = bus.attach({ clientId: "cli-1", flags: { yolo: true } });
    bus.attach({ clientId: "cli-2", flags: { yolo: false } });
    first.detach();

    const third = bus.attach({ clientId: "cli-3", flags: { debug: true } });
    expect(third.flagOwnerClientId).toBe("cli-3");
    expect(third.flags).toEqual({ yolo: false, debug: true });
  });

  it("re-attaching the flag owner does not reset established flags", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });

    const first = bus.attach({ clientId: "cli-1", flags: { yolo: true, debug: true } });
    first.detach();

    const second = bus.attach({ clientId: "cli-1", flags: { yolo: false, debug: false } });
    expect(second.flagOwnerClientId).toBe("cli-1");
    expect(second.flags).toEqual({ yolo: false, debug: false });
  });

  it("documents the precedence rule in a single exported note", () => {
    const note: WorkspaceFlagPrecedence = "first-wins";
    expect(note).toBe("first-wins");
    expect(WORKSPACE_FLAG_PRECEDENCE_NOTE).toMatch(/first client/u);
    expect(WORKSPACE_FLAG_PRECEDENCE_NOTE).toMatch(/yolo/u);
    expect(WORKSPACE_FLAG_PRECEDENCE_NOTE).toMatch(/debug/u);
  });
});

describe("workspaceBus subscriptions and lifecycle", () => {
  it("notifies subscribers of every event and stops after unsubscribe", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    const events = collect(bus);
    const detach = bus.attach({ clientId: "cli-1" });

    detach.detach();
    expect(events).toHaveLength(3);

    // A second listener sees only later events.
    const later: WorkspaceBusEvent[] = [];
    const unsubscribe = bus.subscribe((event) => {
      later.push(event);
    });
    bus.noteSessionStarted({ sessionId: "s-1" });
    expect(later).toHaveLength(1);
    expect(events).toHaveLength(4);

    unsubscribe();
    bus.noteSessionFinished({ sessionId: "s-1" });
    expect(later).toHaveLength(1);
  });

  it("close() stops tracking, clears subscribers, and is idempotent", () => {
    const bus = createWorkspaceBus({ cwd: "/repo" });
    const events = collect(bus);
    const attachment = bus.attach({ clientId: "cli-1" });

    bus.close();
    bus.close();

    // Close tears the bus down: no further events, snapshot/workspace state gone.
    expect(bus.workspace("/repo")).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["workspace.attach", "workspace.flags"]);

    bus.noteSessionStarted({ sessionId: "s-1" });
    expect(events).toHaveLength(2);
    expect(bus.snapshot()).toEqual([]);

    attachment.detach();
    expect(events).toHaveLength(2);
  });
});
