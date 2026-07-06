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

  it("rejects duplicate command ids", () => {
    const host = createExtensionHost();
    host.registerExtension((api) => {
      api.registerCommand("dup", () => {}, { description: "one" });
      api.registerCommand("dup", () => {}, { description: "two" });
    });

    expect(() => host.start()).toThrow("Command already registered: dup");
  });
});
