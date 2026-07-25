import { describe, expect, it } from "vitest";

import { CredentialRoundRobin } from '../../src/providers/credentialRoundRobin.js';

describe("CredentialRoundRobin", () => {
  it("keeps a usable credential sticky to its session", () => {
    const credentials = new CredentialRoundRobin(["credential-a", "credential-b"]);

    expect(credentials.pick("session-a")).toBe("credential-a");
    expect(credentials.pick("session-b")).toBe("credential-b");
    expect(credentials.pick("session-a")).toBe("credential-a");
    expect(credentials.pick("session-c")).toBe("credential-a");
  });

  it("skips failed credentials until their backoff expires", () => {
    let now = 1_000;
    const credentials = new CredentialRoundRobin(["credential-a", "credential-b"], {
      backoffMs: 100,
      now: () => now
    });

    expect(credentials.pick("session-a")).toBe("credential-a");
    credentials.markFail("credential-a");

    expect(credentials.pick("session-a")).toBe("credential-b");
    credentials.markFail("credential-b");
    expect(credentials.pick("session-c")).toBeUndefined();

    now += 100;
    expect(credentials.pick("session-c")).toBe("credential-a");
  });
});
