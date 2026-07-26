import { describe, expect, it } from "vitest";

import {
  runSequential,
  sequentialAgentPipeline,
  type SequentialAgent,
} from "../../src/swarm/sequentialAgentPipeline.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append a suffix (returns a new string — pure). */
function suffix(s: string): (input: string) => string {
  return (input: string) => `${input}${s}`;
}

// ---------------------------------------------------------------------------
// runSequential
// ---------------------------------------------------------------------------

describe("runSequential", () => {
  it("preserves agent order and threads each output to the next input", () => {
    const log: string[] = [];
    const agents: SequentialAgent<string>[] = [
      (input) => {
        log.push(`a:${input}`);
        return `${input}+a`;
      },
      (input) => {
        log.push(`b:${input}`);
        return `${input}+b`;
      },
      (input) => {
        log.push(`c:${input}`);
        return `${input}+c`;
      },
    ];

    const result = runSequential(agents, "seed");

    expect(result).toBe("seed+a+b+c");
    // Each output is threaded as the next input.
    expect(log).toEqual(["a:seed", "b:seed+a", "c:seed+a+b"]);
  });

  it("returns the task unchanged when the agent list is empty", () => {
    const result = runSequential([], "hello");
    expect(result).toBe("hello");
  });

  it("returns the output of a single agent", () => {
    const result = runSequential([(n: number) => n * 2], 21);
    expect(result).toBe(42);
  });

  it("is deterministic — same input produces same output", () => {
    const agents: SequentialAgent<number>[] = [
      (n) => n + 1,
      (n) => n * 2,
      (n) => n - 4,
    ];

    const a = runSequential(agents, 10);
    const b = runSequential(agents, 10);
    expect(a).toBe(b);
    // 10 → 11 → 22 → 18
    expect(a).toBe(18);
  });

  it("is order-dependent — swapping two steps changes the result", () => {
    const add1 = (n: number) => n + 1;
    const mul2 = (n: number) => n * 2;

    const left = runSequential([add1, mul2], 3); // (3+1)*2 = 8
    const right = runSequential([mul2, add1], 3); // (3*2)+1 = 7

    expect(left).not.toBe(right);
    expect(left).toBe(8);
    expect(right).toBe(7);
  });

  it("is lazy in-order — a throw prevents later agents from running", () => {
    const log: string[] = [];
    const agents: SequentialAgent<string>[] = [
      (s) => {
        log.push("first");
        return `${s}-1`;
      },
      (_s) => {
        log.push("thrower");
        throw new Error("pipeline abort");
      },
      (_s) => {
        log.push("third-should-not-run");
        return "never";
      },
    ];

    expect(() => runSequential(agents, "x")).toThrow("pipeline abort");
    // Only the first two agents ran.
    expect(log).toEqual(["first", "thrower"]);
  });

  it("calls each transform exactly once (no fan-out, no duplication)", () => {
    const counts = new Map<string, number>();
    const agents: SequentialAgent<number>[] = [
      (n) => {
        counts.set("a", (counts.get("a") ?? 0) + 1);
        return n + 1;
      },
      (n) => {
        counts.set("b", (counts.get("b") ?? 0) + 1);
        return n * 2;
      },
      (n) => {
        counts.set("c", (counts.get("c") ?? 0) + 1);
        return n - 4;
      },
    ];

    runSequential(agents, 0);

    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(1);
    expect(counts.get("c")).toBe(1);
  });

  it("does not retry — a throw propagates exactly once", () => {
    let calls = 0;
    const agents: SequentialAgent<number>[] = [
      (n) => {
        calls += 1;
        throw new Error("single failure");
      },
    ];

    expect(() => runSequential(agents, 1)).toThrow("single failure");
    expect(calls).toBe(1); // not retried
  });

  it("does not mutate the agents array", () => {
    const agents: SequentialAgent<string>[] = [
      suffix("-a"),
      suffix("-b"),
    ];
    const frozen = Object.freeze([...agents]);

    const result = runSequential(frozen, "x");
    expect(result).toBe("x-a-b");
    // Proof: the original array is unchanged.
    expect(agents).toEqual([suffix("-a"), suffix("-b")]);
  });

  it("accepts an explicit readonly tuple (ReadonlyArray)", () => {
    const agents: readonly SequentialAgent<string>[] = [
      suffix("-p"),
      suffix("-q"),
    ] as const;

    const result = runSequential(agents, "y");
    expect(result).toBe("y-p-q");
  });
});

// ---------------------------------------------------------------------------
// sequentialAgentPipeline (curried alias)
// ---------------------------------------------------------------------------

describe("sequentialAgentPipeline", () => {
  it("returns a function that applies the pipeline to its argument", () => {
    const pipe = sequentialAgentPipeline([
      (n: number) => n + 1,
      (n: number) => n * 3,
    ]);

    expect(pipe(2)).toBe(9); // (2+1)*3 = 9
    expect(pipe(5)).toBe(18); // (5+1)*3 = 18
  });

  it("is equivalent to runSequential for the same agents and task", () => {
    const agents: SequentialAgent<number>[] = [
      (n) => n + 1,
      (n) => n * 2,
      (n) => n - 4,
    ];
    const inputs = [0, 1, 7, -3, 100];

    for (const input of inputs) {
      expect(sequentialAgentPipeline(agents)(input)).toBe(
        runSequential(agents, input),
      );
    }
  });

  it("preserves order and threading when reused", () => {
    const log: string[] = [];
    const agents: SequentialAgent<string>[] = [
      (input) => {
        log.push(`1:${input}`);
        return `${input}>1`;
      },
      (input) => {
        log.push(`2:${input}`);
        return `${input}>2`;
      },
    ];

    const pipe = sequentialAgentPipeline(agents);

    expect(pipe("x")).toBe("x>1>2");
    expect(log).toEqual(["1:x", "2:x>1"]);
  });

  it("passthrough for an empty agent list", () => {
    const pipe = sequentialAgentPipeline([]);
    expect(pipe("unchanged")).toBe("unchanged");
    expect(pipe(42)).toBe(42);
  });

  it("lazy in-order — a throw prevents later agents in curried form", () => {
    const log: string[] = [];
    const agents: SequentialAgent<string>[] = [
      (s) => {
        log.push("first");
        return `${s}-A`;
      },
      (_s) => {
        log.push("thrower");
        throw new Error("curried abort");
      },
      (_s) => {
        log.push("third-should-not-run");
        return "never";
      },
    ];

    const pipe = sequentialAgentPipeline(agents);
    expect(() => pipe("z")).toThrow("curried abort");
    expect(log).toEqual(["first", "thrower"]);
  });
});
