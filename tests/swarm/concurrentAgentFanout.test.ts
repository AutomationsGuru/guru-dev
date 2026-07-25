import { describe, expect, it } from "vitest";

import { runConcurrent, type ConcurrentAgent } from '../../src/swarm/concurrentAgentFanout.js';

describe("runConcurrent — pure concurrent fan-out", () => {
  it("runs every agent with the same task and returns every result by id", async () => {
    const task = { request: "inspect" };
    const seen: unknown[] = [];
    const agents = new Map<string, ConcurrentAgent<typeof task, string>>([
      ["alpha", (input) => {
        seen.push(input);
        return "alpha result";
      }],
      ["beta", async (input) => {
        seen.push(input);
        return "beta result";
      }],
      ["gamma", (input) => {
        seen.push(input);
        return "gamma result";
      }]
    ]);

    const results = await runConcurrent(agents, task);

    expect(results).toEqual(
      new Map([
        ["alpha", "alpha result"],
        ["beta", "beta result"],
        ["gamma", "gamma result"]
      ])
    );
    expect(seen).toHaveLength(3);
    expect(seen.every((input) => input === task)).toBe(true);
    expect([...agents.keys()]).toEqual(["alpha", "beta", "gamma"]);
  });

  it("starts all agents before waiting for any one result", async () => {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const agents = new Map<string, ConcurrentAgent<string, string>>(
      ["first", "second", "third"].map((id) => [
        id,
        () => {
          started.push(id);
          return new Promise<string>((resolve) => {
            releases.push(() => resolve(`${id} done`));
          });
        }
      ])
    );

    const pending = runConcurrent(agents, "shared task");
    await Promise.resolve();

    expect(started).toEqual(["first", "second", "third"]);
    expect(releases).toHaveLength(3);

    for (const release of releases) {
      release();
    }
    await expect(pending).resolves.toEqual(
      new Map([
        ["first", "first done"],
        ["second", "second done"],
        ["third", "third done"]
      ])
    );
  });

  it("returns an empty map without invoking agents", async () => {
    const results = await runConcurrent(new Map(), "unused");

    expect(results).toEqual(new Map());
  });

  it("propagates an agent rejection without retrying or wrapping it", async () => {
    const failure = new Error("agent failed");
    let calls = 0;
    const agents = new Map<string, ConcurrentAgent<string, string>>([
      ["ok", () => {
        calls += 1;
        return "ok";
      }],
      ["bad", () => {
        calls += 1;
        return Promise.reject(failure);
      }]
    ]);

    await expect(runConcurrent(agents, "task")).rejects.toBe(failure);
    expect(calls).toBe(2);
  });
});
