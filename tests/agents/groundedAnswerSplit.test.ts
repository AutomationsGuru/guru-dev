import { describe, expect, it } from "vitest";

import { phaseFor } from '../../src/agents/groundedAnswerSplit.js';

describe("phaseFor", () => {
  it("makes the grounded gather phase tools-only", () => {
    const phase = phaseFor("grounded", "gather");

    expect(phase).toEqual({ canCallTools: true, canEmitUserText: false });
    expect(Object.isFrozen(phase)).toBe(true);
  });

  it("makes the grounded present phase unable to call tools", () => {
    const phase = phaseFor("grounded", "present");

    expect(phase).toEqual({ canCallTools: false, canEmitUserText: true });
    expect(Object.isFrozen(phase)).toBe(true);
  });
});
