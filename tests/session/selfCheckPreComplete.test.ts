import { describe, expect, it } from "vitest";

import { canComplete } from '../../src/session/selfCheckPreComplete.js';

describe("canComplete", () => {
  it("allows completion when every checklist item has passed", () => {
    expect(canComplete([true, true, true])).toBe(true);
  });

  it("blocks completion when any checklist item has not passed", () => {
    expect(canComplete([true, false, true])).toBe(false);
  });
});
