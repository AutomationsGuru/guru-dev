import { describe, expect, it } from "vitest";

import { nextProvider } from '../../src/providers/providerFailoverRank.js';

describe("provider failover rank", () => {
  it("picks the first provider when nothing has failed", () => {
    const rank = ["openai", "anthropic", "gemini"];
    expect(nextProvider(rank, [])).toBe("openai");
  });

  it("skips failed providers and returns the next usable", () => {
    const rank = ["openai", "anthropic", "gemini"];
    expect(nextProvider(rank, ["openai"])).toBe("anthropic");
    expect(nextProvider(rank, ["openai", "anthropic"])).toBe("gemini");
  });

  it("returns undefined when all providers in rank have failed (fail closed)", () => {
    const rank = ["openai", "anthropic"];
    expect(nextProvider(rank, ["openai", "anthropic"])).toBeUndefined();
  });

  it("returns undefined for empty rank (fail closed)", () => {
    expect(nextProvider([], [])).toBeUndefined();
  });

  it("returns undefined for non-array rank (fail closed)", () => {
    // @ts-expect-error testing runtime guard
    expect(nextProvider(null, [])).toBeUndefined();
    // @ts-expect-error testing runtime guard
    expect(nextProvider("openai", [])).toBeUndefined();
  });

  it("returns undefined on malformed rank entry (non-string or empty string)", () => {
    expect(nextProvider(["openai", ""], [])).toBeUndefined();
    // @ts-expect-error testing runtime guard
    expect(nextProvider(["openai", 123], [])).toBeUndefined();
  });

  it("returns undefined when failedIds covers entire rank", () => {
    const rank = ["openai", "anthropic"];
    expect(nextProvider(rank, ["openai", "anthropic", "gemini"])).toBeUndefined();
  });

  it("is pure and does not mutate inputs", () => {
    const rank = ["openai", "anthropic"];
    const failed = ["openai"];
    const beforeRank = [...rank];
    const beforeFailed = [...failed];
    nextProvider(rank, failed);
    expect(rank).toEqual(beforeRank);
    expect(failed).toEqual(beforeFailed);
  });
});
