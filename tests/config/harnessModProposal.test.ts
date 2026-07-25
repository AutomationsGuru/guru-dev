import {
  HarnessModInputSchema,
  proposeHarnessMod,
  PROPOSAL_STATUS,
  applyHarnessModProposal,
  type HarnessModInput
} from '../../src/config/harnessModProposal.js';

describe("HarnessModInputSchema", () => {
  it("parses a minimal mod description", () => {
    const parsed = HarnessModInputSchema.parse({
      summary: "Add a status-line clock",
      rationale: "Operator wants a visible clock",
      proposedChange: "Register a status-line extension through the frozen seam"
    });

    expect(parsed.summary).toBe("Add a status-line clock");
    expect(parsed.rationale).toBe("Operator wants a visible clock");
    expect(parsed.proposedChange).toBe("Register a status-line extension through the frozen seam");
    expect(parsed.target).toBe("core");
    expect(parsed.riskNotes).toBeUndefined();
  });

  it("rejects an empty summary (a mod with no description is not a proposal)", () => {
    expect(() =>
      HarnessModInputSchema.parse({
        summary: "   ",
        rationale: "x",
        proposedChange: "y"
      })
    ).toThrow();
  });

  it("rejects a proposal that asserts its own governance bypass (autoApply is structurally forbidden)", () => {
    // A mod may *describe* touching a hard limit, but the input schema is strict:
    // it cannot carry an `autoApply` / `approved` / `force` flag that would let a
    // mod assert its own governance bypass. The strict() parser rejects unknown keys.
    expect(() =>
      HarnessModInputSchema.parse({
        summary: "lift the spend ceiling",
        rationale: "faster",
        proposedChange: "remove the spend gate",
        autoApply: true
      })
    ).toThrow();
  });
});

describe("proposeHarnessMod", () => {
  it("returns a proposal with status=pending_review and a stable id", () => {
    const proposal = proposeHarnessMod({
      summary: "Add a status-line clock",
      rationale: "Operator wants a visible clock",
      proposedChange: "Register a status-line extension through the frozen seam"
    });

    expect(proposal.status).toBe(PROPOSAL_STATUS.PENDING_REVIEW);
    expect(proposal.id).toMatch(/^harness-mod-[0-9]+-[a-z0-9]{8}$/);
    expect(proposal.applied).toBe(false);
    expect(proposal.createdAtMs).toBeGreaterThan(0);
    expect(proposal.summary).toBe("Add a status-line clock");
  });

  it("never marks a freshly proposed mod as applied (hard limit #5: no ungoverned self-mod)", () => {
    const proposal = proposeHarnessMod({
      summary: "Anything",
      rationale: "Because",
      proposedChange: "Something"
    });

    // A proposal is a review artifact, never an applied mutation.
    expect(proposal.applied).toBe(false);
    expect(proposal.status).not.toBe("applied");
    expect(proposal.status).not.toBe("approved");
  });

  it("captures operator-supplied context verbatim and does not invent approvals", () => {
    const proposal = proposeHarnessMod({
      summary: "Status-line clock",
      rationale: "Visibility",
      proposedChange: "Frozen-seam extension",
      target: "extension",
      riskNotes: "Reads system clock each tick"
    });

    expect(proposal.target).toBe("extension");
    expect(proposal.riskNotes).toBe("Reads system clock each tick");
    // No fabricated reviewer, approver, or applied-marker.
    expect(proposal).not.toHaveProperty("approvedBy");
    expect(proposal).not.toHaveProperty("reviewer");
  });

  it("renders a human-readable review artifact string", () => {
    const proposal = proposeHarnessMod({
      summary: "Status-line clock",
      rationale: "Visibility",
      proposedChange: "Frozen-seam extension"
    });

    const rendered = proposal.render();
    expect(rendered).toContain("Harness Mod Proposal");
    expect(rendered).toContain("status: pending_review");
    expect(rendered).toContain("applied: false");
    expect(rendered).toContain("Status-line clock");
  });

  it("two proposals with identical inputs get distinct ids (no silent dedupe of review items)", () => {
    const input: HarnessModInput = {
      summary: "Status-line clock",
      rationale: "Visibility",
      proposedChange: "Frozen-seam extension"
    };
    const a = proposeHarnessMod(input);
    const b = proposeHarnessMod(input);

    expect(a.id).not.toBe(b.id);
  });
});

describe("applyHarnessModProposal (the governance gate)", () => {
  it("THROWS instead of applying — a proposal is never auto-applied to runtime config", () => {
    const proposal = proposeHarnessMod({
      summary: "Status-line clock",
      rationale: "Visibility",
      proposedChange: "Frozen-seam extension"
    });

    expect(() => applyHarnessModProposal(proposal)).toThrow(/pending_review/);
  });

  it("the proposal object remains un-applied after a rejected apply attempt", () => {
    const proposal = proposeHarnessMod({
      summary: "Status-line clock",
      rationale: "Visibility",
      proposedChange: "Frozen-seam extension"
    });

    expect(() => applyHarnessModProposal(proposal)).toThrow();

    // Structural enforcement: the gate never mutated the artifact into "applied".
    expect(proposal.applied).toBe(false);
    expect(proposal.status).toBe(PROPOSAL_STATUS.PENDING_REVIEW);
  });

  it("the proposal type exposes no mutator that flips applied to true (no auto-apply seam)", () => {
    const proposal = proposeHarnessMod({
      summary: "x",
      rationale: "y",
      proposedChange: "z"
    });

    // The only public surface is render() and read-only fields. Any method that
    // would mark the proposal applied must not exist on the artifact.
    expect(typeof proposal.render).toBe("function");
    expect(proposal).not.toHaveProperty("markApplied");
    expect(proposal).not.toHaveProperty("approve");
    expect(proposal).not.toHaveProperty("apply");
  });
});
