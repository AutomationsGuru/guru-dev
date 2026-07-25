import { describe, expect, it } from "vitest";
import { mayPush } from '../../src/sandbox/hostHeldGitPushGate.js';

describe("hostHeldGitPushGate", () => {
  it("denies push by default", () => {
    expect(mayPush({ env: {} })).toBe(false);
  });

  it("denies push when GURU_HOST_PUSH_APPROVED is not 1", () => {
    expect(mayPush({ env: { GURU_HOST_PUSH_APPROVED: "0" } })).toBe(false);
    expect(mayPush({ env: { GURU_HOST_PUSH_APPROVED: "true" } })).toBe(false);
  });

  it("allows push when host approves via env", () => {
    expect(mayPush({ env: { GURU_HOST_PUSH_APPROVED: "1" } })).toBe(true);
  });

  it("allows push when host provides a token", () => {
    expect(mayPush({ token: "host-provided-token", env: {} })).toBe(true);
  });

  it("denies push with empty token", () => {
    expect(mayPush({ token: "", env: {} })).toBe(false);
  });
});
