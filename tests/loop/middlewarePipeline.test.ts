import { describe, expect, it } from "vitest";

import { apply, type Middleware, type Runner } from '../../src/loop/middlewarePipeline.js';

describe("loop middleware pipeline", () => {
  it("wraps the runner in declaration order", () => {
    const calls: string[] = [];
    const base: Runner<[value: string], string> = (value) => {
      calls.push(`base:${value}`);
      return value.toUpperCase();
    };
    const turnTracking: Middleware<[string], string> = (next) => (value) => {
      calls.push("tracking:before");
      const result = next(value);
      calls.push("tracking:after");
      return result;
    };
    const noop: Middleware<[string], string> = (next) => (value) => {
      calls.push("noop:before");
      const result = next(value);
      calls.push("noop:after");
      return result;
    };

    expect(apply(base, turnTracking, noop)("turn")).toBe("TURN");
    expect(calls).toEqual([
      "tracking:before",
      "noop:before",
      "base:turn",
      "noop:after",
      "tracking:after"
    ]);
  });

  it("returns the original runner when no middleware is supplied", () => {
    const base: Runner<[value: number], number> = (value) => value + 1;

    expect(apply(base)).toBe(base);
  });
});
