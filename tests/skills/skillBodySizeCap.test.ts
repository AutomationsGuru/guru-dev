import { mayActivate } from '../../src/skills/skillBodySizeCap.js';

describe("mayActivate", () => {
  // ── Happy path ──────────────────────────────────────────────────────

  it("returns true when body byte length is under the cap", () => {
    expect(mayActivate("hello", 100)).toBe(true);
  });

  it("returns true when body byte length is exactly the cap", () => {
    const body = "hello"; // 5 bytes
    expect(mayActivate(body, 5)).toBe(true);
  });

  it("returns true for an empty body (0 bytes) with any non-negative cap", () => {
    expect(mayActivate("", 0)).toBe(true);
    expect(mayActivate("", 8000)).toBe(true);
  });

  // ── Over-cap rejection ──────────────────────────────────────────────

  it("returns false when body byte length exceeds the cap", () => {
    expect(mayActivate("hello world", 5)).toBe(false);
  });

  it("returns false when body is one byte over the cap", () => {
    expect(mayActivate("ab", 1)).toBe(false);
  });

  // ── Multi-byte / Unicode ────────────────────────────────────────────

  it("counts bytes, not characters, for multi-byte Unicode", () => {
    // "€" is 3 bytes in UTF-8.
    expect(mayActivate("€", 3)).toBe(true);
    expect(mayActivate("€", 2)).toBe(false);
  });

  it("handles mixed ASCII and multi-byte content", () => {
    // "a€" = 1 + 3 = 4 bytes
    expect(mayActivate("a€", 4)).toBe(true);
    expect(mayActivate("a€", 3)).toBe(false);
  });

  // ── The 8KB boundary (namesake of the feature) ──────────────────────

  it("accepts a body at exactly 8192 bytes", () => {
    const body = "x".repeat(8192);
    expect(mayActivate(body, 8192)).toBe(true);
  });

  it("rejects a body at 8193 bytes with an 8192 cap", () => {
    const body = "x".repeat(8193);
    expect(mayActivate(body, 8192)).toBe(false);
  });

  // ── Input validation ────────────────────────────────────────────────

  it("throws TypeError when body is not a string", () => {
    expect(() => mayActivate(null as unknown as string, 100)).toThrow(TypeError);
    expect(() => mayActivate(undefined as unknown as string, 100)).toThrow(TypeError);
    expect(() => mayActivate(42 as unknown as string, 100)).toThrow(TypeError);
  });

  it("throws RangeError when maxBytes is negative", () => {
    expect(() => mayActivate("hello", -1)).toThrow(RangeError);
  });

  it("throws RangeError when maxBytes is not an integer", () => {
    expect(() => mayActivate("hello", 1.5)).toThrow(RangeError);
  });

  it("throws RangeError when maxBytes is not a safe integer", () => {
    expect(() => mayActivate("hello", Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it("throws RangeError when maxBytes is NaN", () => {
    expect(() => mayActivate("hello", NaN)).toThrow(RangeError);
  });

  it("throws RangeError when maxBytes is Infinity", () => {
    expect(() => mayActivate("hello", Infinity)).toThrow(RangeError);
  });
});
