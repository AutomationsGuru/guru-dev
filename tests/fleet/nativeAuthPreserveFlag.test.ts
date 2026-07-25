import { describe, expect, it } from "vitest";

import { attachSession } from '../../src/fleet/nativeAuthPreserveFlag.js';

describe("attachSession", () => {
  it("preserves non-secret native-auth metadata without copying it", () => {
    const meta = { provider: "external-harness", authMode: "native" };

    const session = attachSession(meta);

    expect(session.metadata).toBe(meta);
    expect(session.preserveNativeAuth).toBe(true);
  });

  it("rejects metadata that declares a secrets field, even when its value is absent", () => {
    const meta = { provider: "external-harness", secrets: undefined };

    expect(() => attachSession(meta)).toThrowError("Native-auth session metadata cannot include a secrets field.");
  });
});
