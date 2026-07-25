import {
  decideGoalCriteria,
  GoalCriterionSchema,
  proposeGoalCriteria
} from '../../src/planning/goalCriteriaDraftReview.js';

const proposalInput = [
  { id: "criterion-1", text: "Focused tests pass for the owned paths." },
  { id: "criterion-2", text: "The draft review applies only on accept." }
];

describe("GoalCriterionSchema", () => {
  it("accepts a bounded criterion", () => {
    const criterion = GoalCriterionSchema.parse({ id: "c-1", text: "Ship the change." });

    expect(criterion.id).toBe("c-1");
  });

  it("rejects blank criterion text", () => {
    const result = GoalCriterionSchema.safeParse({ id: "c-1", text: "   " });

    expect(result.success).toBe(false);
  });

  it("rejects unknown keys", () => {
    const result = GoalCriterionSchema.safeParse({ id: "c-1", text: "Ship.", weight: 3 });

    expect(result.success).toBe(false);
  });
});

describe("proposeGoalCriteria", () => {
  it("creates a pending draft with the proposed criteria and nothing applied", () => {
    const result = proposeGoalCriteria(proposalInput);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.draft.status).toBe("pending");
    expect(result.draft.proposedCriteria).toHaveLength(2);
    expect(result.draft.appliedCriteria).toBeNull();
  });

  it("rejects an empty proposal", () => {
    const result = proposeGoalCriteria([]);

    expect(result.ok).toBe(false);
  });

  it("rejects duplicate criterion ids", () => {
    const result = proposeGoalCriteria([
      { id: "dup", text: "First." },
      { id: "dup", text: "Second." }
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("Duplicate");
  });

  it("rejects invalid criterion input", () => {
    const result = proposeGoalCriteria([{ id: "", text: "No id." }]);

    expect(result.ok).toBe(false);
  });
});

describe("decideGoalCriteria", () => {
  it("accept applies the proposed criteria", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }

    const decided = decideGoalCriteria(proposed.draft, { kind: "accept" });

    expect(decided.ok).toBe(true);
    if (!decided.ok) {
      return;
    }
    expect(decided.draft.status).toBe("accepted");
    expect(decided.draft.appliedCriteria).toEqual(proposalInput);
  });

  it("cancel drops the proposal and applies nothing", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }

    const decided = decideGoalCriteria(proposed.draft, { kind: "cancel" });

    expect(decided.ok).toBe(true);
    if (!decided.ok) {
      return;
    }
    expect(decided.draft.status).toBe("cancelled");
    expect(decided.draft.appliedCriteria).toBeNull();
  });

  it("edit replaces the proposal but stays pending and applies nothing", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }

    const edited = [{ id: "criterion-3", text: "Edited criterion." }];
    const decided = decideGoalCriteria(proposed.draft, { kind: "edit", criteria: edited });

    expect(decided.ok).toBe(true);
    if (!decided.ok) {
      return;
    }
    expect(decided.draft.status).toBe("pending");
    expect(decided.draft.proposedCriteria).toEqual(edited);
    expect(decided.draft.appliedCriteria).toBeNull();
  });

  it("edit rejects invalid replacement criteria", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }

    const decided = decideGoalCriteria(proposed.draft, { kind: "edit", criteria: [] });

    expect(decided.ok).toBe(false);
  });

  it("revise records feedback, keeps the proposal, and applies nothing", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }

    const decided = decideGoalCriteria(proposed.draft, {
      kind: "revise",
      feedback: "Criterion 2 is not measurable; restate it."
    });

    expect(decided.ok).toBe(true);
    if (!decided.ok) {
      return;
    }
    expect(decided.draft.status).toBe("revision-requested");
    expect(decided.draft.revisionFeedback).toBe("Criterion 2 is not measurable; restate it.");
    expect(decided.draft.proposedCriteria).toEqual(proposalInput);
    expect(decided.draft.appliedCriteria).toBeNull();
  });

  it("revise allows a follow-up edit back to pending", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }
    const revised = decideGoalCriteria(proposed.draft, { kind: "revise", feedback: "Tighten scope." });
    expect(revised.ok).toBe(true);
    if (!revised.ok) {
      return;
    }

    const edited = decideGoalCriteria(revised.draft, {
      kind: "edit",
      criteria: [{ id: "criterion-1", text: "Tightened criterion." }]
    });

    expect(edited.ok).toBe(true);
    if (!edited.ok) {
      return;
    }
    expect(edited.draft.status).toBe("pending");
    expect(edited.draft.revisionFeedback).toBeNull();
  });

  it("rejects decisions after accept", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }
    const accepted = decideGoalCriteria(proposed.draft, { kind: "accept" });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      return;
    }

    const cancelled = decideGoalCriteria(accepted.draft, { kind: "cancel" });

    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) {
      return;
    }
    expect(cancelled.error).toContain("terminal");
  });

  it("rejects decisions after cancel so nothing is applied retroactively", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }
    const cancelled = decideGoalCriteria(proposed.draft, { kind: "cancel" });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) {
      return;
    }

    const accepted = decideGoalCriteria(cancelled.draft, { kind: "accept" });

    expect(accepted.ok).toBe(false);
  });

  it("does not mutate the input draft", () => {
    const proposed = proposeGoalCriteria(proposalInput);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }

    decideGoalCriteria(proposed.draft, { kind: "cancel" });

    expect(proposed.draft.status).toBe("pending");
    expect(proposed.draft.appliedCriteria).toBeNull();
  });
});
