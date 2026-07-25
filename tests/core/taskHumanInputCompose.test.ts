import { canComplete } from '../../src/core/taskHumanInputCompose.js';

describe("canComplete", () => {
  it("should block completion when humanInput is true and no receipt is given", () => {
    const result = canComplete({ humanInput: true });

    expect(result.allowed).toBe(false);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/human input/i);
      expect(result.reason).toMatch(/receipt/i);
    }
  });

  it("should block completion when humanInput is true and receipt is undefined", () => {
    const result = canComplete({ humanInput: true }, undefined);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/receipt/i);
    }
  });

  it("should block completion when humanInput is true and receipt has an empty receivedBy", () => {
    const result = canComplete({ humanInput: true }, { receivedBy: "" });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/receipt/i);
    }
  });

  it("should block completion when humanInput is true and receipt has a whitespace-only receivedBy", () => {
    const result = canComplete({ humanInput: true }, { receivedBy: "   " });

    expect(result.allowed).toBe(false);
  });

  it("should block completion when humanInput is true and receipt is not an object", () => {
    expect(canComplete({ humanInput: true }, "matthew").allowed).toBe(false);
    expect(canComplete({ humanInput: true }, null).allowed).toBe(false);
    expect(canComplete({ humanInput: true }, 42).allowed).toBe(false);
  });

  it("should allow completion when humanInput is true and a valid receipt is present", () => {
    const result = canComplete({ humanInput: true }, { receivedBy: "matthew" });

    expect(result).toEqual({ allowed: true });
  });

  it("should allow completion when humanInput is true and a receipt with optional fields is present", () => {
    const result = canComplete(
      { humanInput: true },
      { receivedBy: "matthew", receivedAt: "2026-07-20T00:00:00Z", note: "Looks good." }
    );

    expect(result).toEqual({ allowed: true });
  });

  it("should allow completion when humanInput is false and no receipt is present", () => {
    expect(canComplete({ humanInput: false })).toEqual({ allowed: true });
  });

  it("should allow completion when humanInput is false and a valid receipt is present", () => {
    expect(canComplete({ humanInput: false }, { receivedBy: "matthew" })).toEqual({ allowed: true });
  });

  it("should allow completion when humanInput is false even with a malformed receipt", () => {
    expect(canComplete({ humanInput: false }, "not-a-receipt")).toEqual({ allowed: true });
  });

  it("should allow completion when humanInput is absent and no receipt is present", () => {
    expect(canComplete({})).toEqual({ allowed: true });
  });
});
