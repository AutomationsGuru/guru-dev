import { describe, expect, it } from "vitest";

import { maybeOffload, get } from '../../src/session/toolOutputOffloadStore.js';

describe("toolOutputOffloadStore", () => {
  it("returns the result untouched when it is under the threshold", () => {
    const result = "small output";
    const outcome = maybeOffload(result, 100);

    expect(outcome).toEqual({ display: result });
    expect(outcome.ref).toBeUndefined();
  });

  it("returns the result untouched when it equals the threshold", () => {
    const result = "x".repeat(100);
    const outcome = maybeOffload(result, 100);

    expect(outcome).toEqual({ display: result });
    expect(outcome.ref).toBeUndefined();
  });

  it("offloads a result over the threshold and returns a pointer display", () => {
    const result = "y".repeat(500);
    const outcome = maybeOffload(result, 100);

    expect(outcome.ref).toBeDefined();
    expect(outcome.display).not.toBe(result);
    expect(outcome.display.length).toBeLessThan(result.length);
    expect(outcome.display).toContain(outcome.ref as string);
  });

  it("get(ref) retrieves the full stored body", () => {
    const result = "z".repeat(500);
    const outcome = maybeOffload(result, 100);

    expect(get(outcome.ref as string)).toBe(result);
  });

  it("get returns undefined for an unknown ref", () => {
    expect(get("offload:does-not-exist")).toBeUndefined();
  });
});
