import { createExtensionHost } from "../../src/extensions/host.js";
import { createEventBus, LifecycleEvents } from "../../src/extensions/events.js";

describe("createEventBus", () => {
  it("registers, emits, counts, and removes a listener", () => {
    const bus = createEventBus();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };

    bus.on(LifecycleEvents.INPUT_RECEIVED, listener);
    expect(bus.listenerCount(LifecycleEvents.INPUT_RECEIVED)).toBe(1);

    bus.emit(LifecycleEvents.INPUT_RECEIVED, { sessionId: "s1", input: "hi" });
    expect(calls).toBe(1);

    bus.off(LifecycleEvents.INPUT_RECEIVED, listener);
    bus.emit(LifecycleEvents.INPUT_RECEIVED, { sessionId: "s1", input: "hi" });
    expect(calls).toBe(1);
    expect(bus.listenerCount(LifecycleEvents.INPUT_RECEIVED)).toBe(0);
  });

  it("removeAllListeners clears every event", () => {
    const bus = createEventBus();
    bus.on(LifecycleEvents.SESSION_START, () => {});
    bus.on(LifecycleEvents.SESSION_END, () => {});
    bus.removeAllListeners();

    expect(bus.listenerCount(LifecycleEvents.SESSION_START)).toBe(0);
    expect(bus.listenerCount(LifecycleEvents.SESSION_END)).toBe(0);
  });
});

describe("createExtensionHost", () => {
  it("defers extension registration until start(), then registers commands/tools/routes", () => {
    const host = createExtensionHost();
    host.registerExtension((api) => {
      api.registerCommand("demo.hello", () => {}, { description: "demo command" });
      api.registerTool({ factory: () => [] });
      api.registerRoute("GET", "/demo", async () => ({ ok: true }));
    });

    // Nothing is registered until the host starts.
    expect(host.getCommandRegistry().size).toBe(0);
    expect(host.getToolFactories().length).toBe(0);
    expect(host.getRouteRegistry().length).toBe(0);

    host.start();

    expect(host.getCommandRegistry().has("demo.hello")).toBe(true);
    expect(host.getToolFactories().length).toBe(1);
    expect(host.getRouteRegistry().length).toBe(1);
    expect(host.getRouteRegistry()[0]).toMatchObject({ method: "GET", path: "/demo" });

    host.stop();
  });

  it("dispatches lifecycle events to extension listeners and emits session:start on start()", () => {
    const host = createExtensionHost();
    const received: string[] = [];
    host.registerExtension((api) => {
      api.on(LifecycleEvents.SESSION_START, (payload) => {
        received.push(payload.sessionId);
      });
    });

    host.start();
    expect(received).toContain("host");

    host.stop();
  });

  it("keeps the FIRST registration on a duplicate command id (warns, doesn't throw) (review 2026-07-08)", () => {
    const host = createExtensionHost();
    const calls: string[] = [];
    host.registerExtension((api) => {
      api.registerCommand("dup", () => { calls.push("one"); }, { description: "one" });
      api.registerCommand("dup", () => { calls.push("two"); }, { description: "two" });
    });

    // Old behavior threw "Command already registered" from inside start(), which
    // aborted the host for every other extension. Now it warns + keeps the first.
    expect(() => host.start()).not.toThrow();
    const entry = host.getCommandRegistry().get("dup");
    expect(entry).toBeDefined();
    entry?.handler([]);
    expect(calls).toEqual(["one"]);
  });

  it("isolates a throwing extension so the rest of the host still activates (review 2026-07-08)", () => {
    const host = createExtensionHost();
    const calls: string[] = [];
    host.registerExtension(() => {
      throw new Error("boom in ext A");
    });
    host.registerExtension((api) => {
      api.registerCommand("good", () => { calls.push("ok"); }, { description: "good ext" });
    });

    // Old behavior: ext A's throw aborted start(), so the good command never
    // registered and active stayed false. Now A is skipped with a warning and B
    // still activates.
    expect(() => host.start()).not.toThrow();
    const entry = host.getCommandRegistry().get("good");
    expect(entry).toBeDefined();
    entry?.handler([]);
    expect(calls).toEqual(["ok"]);
  });

  it("a second start() rebuilds the registry from scratch (no doubling) (review 2026-07-08)", () => {
    const host = createExtensionHost();
    host.registerExtension((api) => {
      api.registerCommand("once", () => {}, { description: "x" });
    });
    host.start();
    host.stop();
    host.start(); // re-start — old behavior DOUBLED the registration

    // The command must appear exactly once (not twice).
    const commands = [...host.getCommandRegistry().keys()].filter((id) => id === "once");
    expect(commands).toHaveLength(1);
  });
});
