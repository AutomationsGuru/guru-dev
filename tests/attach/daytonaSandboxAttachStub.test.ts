import { describe, expect, it } from "vitest";

import {
  DAYTONA_SANDBOX_PROVIDER_ID,
  daytonaSandboxAttachStub,
  parityGap
} from '../../src/attach/daytonaSandboxAttachStub.js';

describe("Daytona sandbox ATTACH stub (IDEA-F232-DAYTONA-ATTACH-01)", () => {
  it("exposes a stable provider id", () => {
    expect(DAYTONA_SANDBOX_PROVIDER_ID).toBe("daytona-sandbox");
  });

  it("returns a non-empty ATTACH parity gap", () => {
    const gap = parityGap();

    expect(gap.id).toBeTruthy();
    expect(gap.capability).toBeTruthy();
    expect(gap.move).toBe("attach");
    expect(gap.note).toBeTruthy();
    expect(gap.trigger).toMatch(/^tool:/u);
  });

  it("keeps the gap identity stable across calls", () => {
    const first = parityGap();
    const second = parityGap();

    expect(second.id).toBe(first.id);
    expect(second.capability).toBe(first.capability);
  });

  it("returns the provider id and gap together", () => {
    const stub = daytonaSandboxAttachStub();

    expect(stub.providerId).toBe(DAYTONA_SANDBOX_PROVIDER_ID);
    expect(stub.gap.move).toBe("attach");
  });
});
