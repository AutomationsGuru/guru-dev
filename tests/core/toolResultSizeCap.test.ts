import { capResult } from '../../src/core/toolResultSizeCap.js';

describe("capResult", () => {
  it("returns text unchanged when under cap", () => {
    const text = "hello world";
    expect(capResult(text, 100)).toBe(text);
  });

  it("returns text unchanged when exactly at cap", () => {
    const text = "exact";
    // "exact" is 5 bytes
    expect(capResult(text, 5)).toBe(text);
  });

  it("truncates over cap and appends marker", () => {
    const text = "this is a long string that exceeds the limit";
    const result = capResult(text, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("[truncated");
  });

  it("truncation result never exceeds maxBytes", () => {
    const text = "x".repeat(100);
    const result = capResult(text, 30);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(30);
  });

  it("does not split multi-byte UTF-8 characters", () => {
    // Emoji is 4 bytes each in UTF-8
    const text = "😀😀😀😀😀😀😀😀😀😀"; // 10 emojis = 40 bytes
    const result = capResult(text, 15);
    // Should cut cleanly before a full emoji, not mid-sequence
    expect(result).not.toContain("�"); // no replacement char
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(15);
  });

  it("handles CJK characters without splitting", () => {
    const text = "日本語テスト文字列です"; // multi-byte
    const result = capResult(text, 10);
    expect(result).not.toContain("�");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(10);
  });

  it("throws on negative maxBytes", () => {
    expect(() => capResult("test", -1)).toThrow(/maxBytes/i);
  });

  it("throws on non-integer maxBytes", () => {
    expect(() => capResult("test", 10.5)).toThrow(/maxBytes/i);
  });

  it("throws on NaN maxBytes", () => {
    expect(() => capResult("test", NaN)).toThrow(/maxBytes/i);
  });

  it("returns empty string for empty input under cap", () => {
    expect(capResult("", 10)).toBe("");
  });

  it("returns marker (truncated if needed) when maxBytes is smaller than marker", () => {
    const text = "anything";
    // maxBytes too small for any real marker; behavior must still be safe
    const result = capResult(text, 3);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(3);
  });

  it("maxBytes=0 yields empty or minimal safe output", () => {
    const result = capResult("anything", 0);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(0);
  });
});
