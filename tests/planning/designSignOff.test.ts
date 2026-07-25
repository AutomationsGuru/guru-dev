import { describe, expect, it } from "vitest";

import {
  DesignDocSchema,
  SignOffSchema,
  canImplement,
  type DesignDoc,
  type DesignSection,
  type SignOff
} from '../../src/planning/designSignOff.js';

const approvedAt = "2026-07-19T14:31:00.000Z";

function baseSections(): DesignSection[] {
  return [
    { id: "goal", title: "Goal", status: "approved" },
    { id: "scope", title: "Scope", status: "approved" }
  ];
}

describe("DesignDocSchema", () => {
  it("requires an id and a sections array", () => {
    const result = DesignDocSchema.safeParse({ sections: baseSections() });
    expect(result.success).toBe(false);
  });

  it("parses a design doc with chunked sections", () => {
    const doc = DesignDocSchema.parse({ id: "design-1", sections: baseSections() });
    expect(doc.id).toBe("design-1");
    expect(doc.sections).toHaveLength(2);
  });
});

describe("SignOffSchema", () => {
  it("requires approvedAt as an ISO datetime", () => {
    const result = SignOffSchema.safeParse({ approvedAt: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("allows an override only when a reason is present", () => {
    const noReason = SignOffSchema.safeParse({ approvedAt, override: {} });
    expect(noReason.success).toBe(false);

    const withReason = SignOffSchema.safeParse({
      approvedAt,
      override: { reason: "Operator forced through pending section." }
    });
    expect(withReason.success).toBe(true);
  });
});

describe("canImplement", () => {
  const design: DesignDoc = { id: "design-1", sections: baseSections() };

  it("returns false when there is no sign-off", () => {
    expect(canImplement(design, undefined)).toBe(false);
    expect(canImplement(design, null)).toBe(false);
  });

  it("returns true when the design is approved", () => {
    const signOff: SignOff = { approvedAt };
    expect(canImplement(design, signOff)).toBe(true);
  });

  it("returns true when an override carries a reason", () => {
    const signOff: SignOff = {
      approvedAt,
      override: { reason: "Operator forced through pending section." }
    };
    expect(canImplement(design, signOff)).toBe(true);
  });

  it("returns false for a sign-off missing an approvedAt", () => {
    expect(canImplement(design, { approvedAt: "" } as unknown as SignOff)).toBe(false);
  });

  it("returns false for an override with no reason", () => {
    expect(
      canImplement(design, { approvedAt, override: {} } as unknown as SignOff)
    ).toBe(false);
  });
});
