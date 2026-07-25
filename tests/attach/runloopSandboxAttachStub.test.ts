import { describe, expect, it } from "vitest";

import {
  parityGap,
  RUNLOOP_SANDBOX_PROVIDER_ID,
  runloopSandboxAttachStub
} from '../../src/attach/runloopSandboxAttachStub.js';

describe("Runloop sandbox ATTACH stub (IDEA-F235-RUNLOOP-01)", () => {
  describe("providerId", () => {
    it("is a non-empty stable string", () => {
      expect(RUNLOOP_SANDBOX_PROVIDER_ID).toBe("runloop-sandbox");
    });
  });

  describe("parityGap", () => {
    it("returns a non-null gap record", () => {
      const gap = parityGap();
      expect(gap).toBeDefined();
      expect(gap.id).toBeTruthy();
      expect(gap.capability).toBeTruthy();
    });

    it("gap records an ATTACH move (never a silent dependency)", () => {
      const gap = parityGap();
      expect(gap.move).toBe("attach");
    });

    it("gap id is deterministic for the Runloop need", () => {
      const a = parityGap();
      const b = parityGap();
      expect(a.id).toBe(b.id);
      expect(a.capability).toBe(b.capability);
    });

    it("gap carries a machine-evaluable trigger (not empty)", () => {
      const gap = parityGap();
      expect(gap.trigger).toBeTruthy();
      expect(gap.trigger).toMatch(/^tool:/);
    });

    it("gap note names the attach surface and forward lane", () => {
      const gap = parityGap();
      expect(gap.note).toMatch(/Runloop/);
      expect(gap.note).toMatch(/F215/);
    });
  });

  describe("runloopSandboxAttachStub", () => {
    it("returns providerId and gap together", () => {
      const stub = runloopSandboxAttachStub();
      expect(stub.providerId).toBe(RUNLOOP_SANDBOX_PROVIDER_ID);
      expect(stub.gap).toBeDefined();
      expect(stub.gap.move).toBe("attach");
    });
  });
});