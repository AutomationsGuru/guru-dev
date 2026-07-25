import { describe, expect, it } from "vitest";

import { noticeIfFallback } from '../../src/tools/xmlToolcallFallbackNotice.js';

describe("noticeIfFallback", () => {
  it("emits an operator-visible notice for the first XML fallback in a turn", () => {
    expect(noticeIfFallback({ usedXmlFallback: true, alreadyNotified: false })).toBe(true);
  });

  it("does not duplicate a notice within the same turn", () => {
    expect(noticeIfFallback({ usedXmlFallback: true, alreadyNotified: true })).toBe(false);
  });

  it("does not emit a notice when XML fallback was not used", () => {
    expect(noticeIfFallback({ usedXmlFallback: false, alreadyNotified: false })).toBe(false);
  });
});
