import type { ContextProvider, ContextProviderQuery } from '../../src/context/contextProviderRegistry.js';
import {
  createContextProviderRegistry,
  collectContextProviders
} from '../../src/context/contextProviderRegistry.js';

function createEchoProvider(id: string, priority: number, snippets: readonly string[]): ContextProvider {
  return {
    id,
    priority,
    async collect(_query: ContextProviderQuery): Promise<readonly string[]> {
      return snippets;
    }
  };
}

function createFailingProvider(id: string): ContextProvider {
  return {
    id,
    priority: 0,
    async collect(): Promise<readonly string[]> {
      throw new Error(`${id} blew up`);
    }
  };
}

describe("createContextProviderRegistry", () => {
  it("registers providers and lists them sorted by priority ascending then id", () => {
    const registry = createContextProviderRegistry([
      createEchoProvider("zeta", 10, ["z"]),
      createEchoProvider("alpha", 10, ["a"]),
      createEchoProvider("mu", 5, ["m"])
    ]);

    expect(registry.list().map((provider) => provider.id)).toEqual(["mu", "alpha", "zeta"]);
    expect(registry.get("alpha")?.id).toBe("alpha");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("rejects duplicate provider ids during construction", () => {
    expect(() =>
      createContextProviderRegistry([
        createEchoProvider("dupe", 0, ["a"]),
        createEchoProvider("dupe", 0, ["b"])
      ])
    ).toThrow("Context provider already registered: dupe");
  });

  it("rejects duplicate provider ids added via register()", () => {
    const registry = createContextProviderRegistry();

    registry.register(createEchoProvider("solo", 0, ["x"]));

    expect(() => registry.register(createEchoProvider("solo", 0, ["y"]))).toThrow(
      "Context provider already registered: solo"
    );
  });
});

describe("collectContextProviders", () => {
  it("collects snippets from every provider in priority order and flattens the result", async () => {
    const registry = createContextProviderRegistry([
      createEchoProvider("zeta", 20, ["z1", "z2"]),
      createEchoProvider("alpha", 10, ["a1"]),
      createEchoProvider("mu", 30, ["m1"])
    ]);

    const snippets = await collectContextProviders(registry, { runId: "run-1" });

    expect(snippets).toEqual(["a1", "z1", "z2", "m1"]);
  });

  it("passes the same query object to every provider and records calls in invocation order", async () => {
    const received: Array<{ id: string; query: ContextProviderQuery }> = [];
    const registry = createContextProviderRegistry([
      {
        id: "recorder-a",
        priority: 0,
        async collect(query) {
          received.push({ id: "recorder-a", query });
          return ["a"];
        }
      },
      {
        id: "recorder-b",
        priority: 1,
        async collect(query) {
          received.push({ id: "recorder-b", query });
          return ["b"];
        }
      }
    ]);

    const query: ContextProviderQuery = { runId: "run-7", cwd: "/tmp" };
    const snippets = await collectContextProviders(registry, query);

    expect(snippets).toEqual(["a", "b"]);
    expect(received.map((entry) => entry.id)).toEqual(["recorder-a", "recorder-b"]);
    expect(received.every((entry) => entry.query === query)).toBe(true);
  });

  it("skips providers that throw and continues collecting from the others", async () => {
    const registry = createContextProviderRegistry([
      createFailingProvider("boom"),
      createEchoProvider("ok", 0, ["good"]),
      createFailingProvider("boom-2")
    ]);

    const snippets = await collectContextProviders(registry, {});

    expect(snippets).toEqual(["good"]);
  });

  it("returns an empty array when no providers are registered", async () => {
    const registry = createContextProviderRegistry();

    const snippets = await collectContextProviders(registry, {});

    expect(snippets).toEqual([]);
  });

  it("awaits providers even when their snippet list is empty", async () => {
    let invocations = 0;
    const registry = createContextProviderRegistry([
      {
        id: "empty-a",
        priority: 0,
        async collect() {
          invocations += 1;
          return [];
        }
      },
      {
        id: "empty-b",
        priority: 1,
        async collect() {
          invocations += 1;
          return [];
        }
      }
    ]);

    const snippets = await collectContextProviders(registry, {});

    expect(snippets).toEqual([]);
    expect(invocations).toBe(2);
  });
});
