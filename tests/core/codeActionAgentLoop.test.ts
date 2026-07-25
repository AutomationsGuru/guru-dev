import { describe, expect, it } from "vitest";

import {
  parseAction,
  runCodeActionLoop,
  type ToolFn
} from '../../src/core/codeActionAgentLoop.js';

describe("parseAction", () => {
  it("parses function-call tool and final_answer forms", () => {
    expect(parseAction("search(hello world)")).toEqual({
      kind: "tool",
      name: "search",
      args: "hello world"
    });
    expect(parseAction("noop()")).toEqual({
      kind: "tool",
      name: "noop",
      args: ""
    });
    expect(parseAction("final_answer(42)")).toEqual({
      kind: "final_answer",
      text: "42"
    });
    expect(parseAction('final_answer("done")')).toEqual({
      kind: "final_answer",
      text: "done"
    });
  });

  it("parses labeled tool and final_answer forms", () => {
    expect(parseAction("final_answer: done")).toEqual({
      kind: "final_answer",
      text: "done"
    });
    expect(parseAction("tool echo: hi")).toEqual({
      kind: "tool",
      name: "echo",
      args: "hi"
    });
  });

  it("strips a single-line code fence before parsing", () => {
    expect(parseAction("```python\nsearch(q)\n```")).toEqual({
      kind: "tool",
      name: "search",
      args: "q"
    });
  });

  it("returns null for empty or non-action lines", () => {
    expect(parseAction("")).toBeNull();
    expect(parseAction("   ")).toBeNull();
    expect(parseAction("just text")).toBeNull();
    expect(parseAction("()")).toBeNull();
  });
});

describe("runCodeActionLoop", () => {
  const tools: Readonly<Record<string, ToolFn>> = {
    echo: (args) => `echoed:${args}`,
    add: (args) => {
      const [a, b] = args.split(",").map((s) => Number(s.trim()));
      return String((a ?? 0) + (b ?? 0));
    }
  };

  it("invokes tools across multiple steps then stops on final_answer", () => {
    const lines = [
      "echo(hello)",
      "add(2, 3)",
      'final_answer("sum was 5")'
    ];
    let i = 0;
    const result = runCodeActionLoop((history) => {
      expect(Array.isArray(history)).toBe(true);
      return lines[i++]!;
    }, tools);

    expect(result.stopped).toBe("final_answer");
    expect(result.answer).toBe("sum was 5");
    expect(result.steps).toEqual([
      "echo(hello)",
      "echoed:hello",
      "add(2, 3)",
      "5",
      'final_answer("sum was 5")'
    ]);
    expect(i).toBe(3);
  });

  it("stops with maxSteps when no final_answer is produced", () => {
    let calls = 0;
    const result = runCodeActionLoop(
      () => {
        calls += 1;
        return `echo(step-${calls})`;
      },
      tools,
      { maxSteps: 3 }
    );

    expect(result.stopped).toBe("maxSteps");
    expect(result.answer).toBeNull();
    expect(calls).toBe(3);
    expect(result.steps).toEqual([
      "echo(step-1)",
      "echoed:step-1",
      "echo(step-2)",
      "echoed:step-2",
      "echo(step-3)",
      "echoed:step-3"
    ]);
  });

  it("defaults maxSteps to 8", () => {
    let calls = 0;
    const result = runCodeActionLoop(() => {
      calls += 1;
      return `echo(${calls})`;
    }, tools);

    expect(result.stopped).toBe("maxSteps");
    expect(calls).toBe(8);
    expect(result.steps.filter((s) => s.startsWith("echo("))).toHaveLength(8);
  });

  it("fails closed on unknown tools as a step error string and continues", () => {
    const lines = ["missing(x)", "final_answer(recovered)"];
    let i = 0;
    const result = runCodeActionLoop(() => lines[i++]!, tools);

    expect(result.stopped).toBe("final_answer");
    expect(result.answer).toBe("recovered");
    expect(result.steps).toEqual([
      "missing(x)",
      "error: unknown tool: missing",
      "final_answer(recovered)"
    ]);
  });

  it("fails closed on unparseable action lines as a step error string", () => {
    const lines = ["not an action", "final_answer(ok)"];
    let i = 0;
    const result = runCodeActionLoop(() => lines[i++]!, tools);

    expect(result.stopped).toBe("final_answer");
    expect(result.answer).toBe("ok");
    expect(result.steps[0]).toBe("not an action");
    expect(result.steps[1]).toMatch(/^error: unparseable action:/);
  });

  it("passes growing history into decide in order", () => {
    const seen: number[] = [];
    const lines = ["echo(a)", "echo(b)", "final_answer(done)"];
    let i = 0;
    const result = runCodeActionLoop((history) => {
      seen.push(history.length);
      return lines[i++]!;
    }, tools);

    expect(result.stopped).toBe("final_answer");
    expect(seen).toEqual([0, 2, 4]);
    expect(result.steps).toHaveLength(5);
  });

  it("fails closed when maxSteps is less than 1", () => {
    expect(() =>
      runCodeActionLoop(() => "final_answer(x)", tools, { maxSteps: 0 })
    ).toThrow(/maxSteps must be >= 1/);
  });

  it("records tool throw as a fail-closed step error string", () => {
    const boomTools: Readonly<Record<string, ToolFn>> = {
      boom: () => {
        throw new Error("kaboom");
      }
    };
    const lines = ["boom()", "final_answer(after)"];
    let i = 0;
    const result = runCodeActionLoop(() => lines[i++]!, boomTools);

    expect(result.stopped).toBe("final_answer");
    expect(result.steps[1]).toBe("error: tool boom threw: kaboom");
    expect(result.answer).toBe("after");
  });

  it("supports labeled multi-call step then final stop", () => {
    const lines = ["tool echo: a", "tool add: 1, 2", "final_answer: three"];
    let i = 0;
    const result = runCodeActionLoop(() => lines[i++]!, tools);
    expect(result.stopped).toBe("final_answer");
    expect(result.answer).toBe("three");
    expect(result.steps).toEqual([
      "tool echo: a",
      "echoed:a",
      "tool add: 1, 2",
      "3",
      "final_answer: three"
    ]);
  });
});
