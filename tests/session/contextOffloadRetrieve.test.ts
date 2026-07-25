import { describe, expect, it } from "vitest";

import { expandPointers } from '../../src/session/contextOffloadRetrieve.js';

describe("contextOffloadRetrieve", () => {
  it("expands each stored offload pointer to its full content", () => {
    const store = new Map([
      ["offload:1", "first full result"],
      ["offload:2", "second full result"]
    ]);

    expect(expandPointers("Before offload:1, then offload:2.", store)).toBe(
      "Before first full result, then second full result."
    );
  });

  it("leaves a clear note when an offload pointer is missing", () => {
    const store = new Map<string, string>();

    expect(expandPointers("Inspect offload:99.", store)).toBe(
      "Inspect [offloaded content unavailable: offload:99]."
    );
  });
});
