import { describe, expect, it } from "vitest";

import {
  LearningSchema,
  citeLearning,
  classifyDecay,
  decaySweep,
  decayScore,
  detectCrossLevelConflicts,
  extractLearnings,
  gateLearning,
  idleSessions,
  learningId,
  promoteSweep,
  rankForInjection,
  resolveSupersessions,
  type Learning
} from "../../src/garage/flywheel.js";

const NOW = new Date(Date.UTC(2026, 6, 5));
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function learning(over: Partial<Learning> & { statement: string; subject: string }): Learning {
  return LearningSchema.parse({
    id: over.id ?? learningId(over.scope ?? "role", over.level ?? "L1", over.statement),
    scope: "role",
    level: "L1",
    createdAt: daysAgo(0),
    ...over
  });
}

describe("EXTRACT", () => {
  it("turns a suited session into grounded L1 learnings (suit-level + per-tool), self-generated", () => {
    const learnings = extractLearnings({ roleSlug: "finance", toolsUsed: ["git.pr.run", "edit"], routeId: "openai:gpt", turns: 3, now: () => NOW });
    expect(learnings).toHaveLength(3); // 1 suit-level + 2 per-tool
    expect(learnings.every((l) => l.level === "L1" && l.validated === false)).toBe(true);
    expect(learnings.some((l) => l.tools.includes("git.pr.run"))).toBe(true);
  });

  it("no turns or no tools → nothing extracted (never invents)", () => {
    expect(extractLearnings({ roleSlug: "x", toolsUsed: [], routeId: "r", turns: 5, now: () => NOW })).toEqual([]);
    expect(extractLearnings({ roleSlug: "x", toolsUsed: ["a"], routeId: "r", turns: 0, now: () => NOW })).toEqual([]);
  });

  it("deterministic id: the same learning maps to the same fact (idempotent)", () => {
    expect(learningId("role", "L1", "Tool X works")).toBe(learningId("role", "L1", "tool   x   works"));
  });
});

describe("GATE", () => {
  it("validation-gated promotion: validated earns weight 16, self-generated earns 0", () => {
    const val = learning({ statement: "Always run the migration before deploy.", subject: "deploy", validated: true });
    const self = learning({ statement: "Tool edit was useful for the app suit.", subject: "edit" });
    expect(gateLearning(val, new Set()).promoteWeight).toBe(16);
    expect(gateLearning(self, new Set()).promoteWeight).toBe(0);
  });

  it("rejects too-short and duplicate learnings", () => {
    expect(gateLearning(learning({ statement: "short", subject: "s" }), new Set()).admit).toBe(false);
    const dup = learning({ statement: "Tool edit was useful for the app suit.", subject: "edit" });
    expect(gateLearning(dup, new Set([dup.id])).admit).toBe(false);
  });
});

describe("INJECT (decay-ranked)", () => {
  it("cited + recent + task-relevant learnings rank above uncited/stale/irrelevant", () => {
    const cited = learning({ statement: "Reconcile ledger nightly for finance.", subject: "finance", citations: [{ at: daysAgo(1), outcome: "used" }] });
    const stale = learning({ statement: "Old note about something unrelated.", subject: "misc", createdAt: daysAgo(60) });
    expect(decayScore(cited, NOW)).toBeGreaterThan(decayScore(stale, NOW));
    // Task boost: a finance task lifts the finance learning further.
    const boosted = decayScore(cited, NOW, new Set(["finance", "ledger"]));
    expect(boosted).toBeGreaterThan(decayScore(cited, NOW));
  });

  it("rankForInjection respects the line budget", () => {
    const many = Array.from({ length: 20 }, (_, i) => learning({ statement: `Learning number ${i} about topic ${i}.`, subject: `t${i}` }));
    const picked = rankForInjection(many, { now: NOW, budget: { maxLines: 5, maxChars: 10_000 } });
    expect(picked).toHaveLength(5);
  });

  it("rankForInjection drops non-finite scores (bad dates) without blanking good learnings", () => {
    const good = learning({ statement: "Valid finance path learning here.", subject: "finance", createdAt: daysAgo(1) });
    const badDate = learning({
      statement: "Malformed date learning still has a long enough statement.",
      subject: "broken",
      createdAt: "not-a-date"
    });
    const picked = rankForInjection([badDate, good], { now: NOW, budget: { maxLines: 8, maxChars: 10_000 } });
    expect(picked.map((item) => item.id)).toEqual([good.id]);
    expect(picked).toHaveLength(1);
  });
});

describe("CITE", () => {
  it("records an application: bumps citations, sets lastCitedAt, lifts confidence", () => {
    const before = learning({ statement: "Tool git.pr.run helps finance.", subject: "finance", confidence: 0.5 });
    const after = citeLearning(before, { at: daysAgo(0), outcome: "used" });
    expect(after.citations).toHaveLength(1);
    expect(after.lastCitedAt).toBe(daysAgo(0));
    expect(after.confidence).toBeGreaterThan(before.confidence);
  });
});

describe("DECAY", () => {
  it("classifies by idle days (sessions-as-days proxy)", () => {
    const thresholds = { reviewAfterDays: 14, pruneAfterDays: 28 };
    expect(classifyDecay(learning({ statement: "fresh enough learning here", subject: "a" }), NOW, thresholds)).toBe("keep");
    expect(classifyDecay(learning({ statement: "middling learning here now", subject: "b", createdAt: daysAgo(20) }), NOW, thresholds)).toBe("review");
    expect(classifyDecay(learning({ statement: "ancient learning here now", subject: "c", createdAt: daysAgo(40) }), NOW, thresholds)).toBe("prune");
  });

  it("a newer opposite-polarity same-level+subject learning supersedes the older", () => {
    const old = learning({ statement: "Use approach A for billing.", subject: "billing", polarity: "affirm", createdAt: daysAgo(10) });
    const neu = learning({ statement: "Do NOT use approach A for billing.", subject: "billing", polarity: "deny", createdAt: daysAgo(1) });
    const { kept, superseded } = resolveSupersessions([old, neu]);
    expect(superseded.map((l) => l.id)).toEqual([old.id]);
    expect(kept.map((l) => l.id)).toEqual([neu.id]);
  });

  it("cross-level conflict (L3 rule vs L2 skill, same subject, opposite polarity) surfaces for review", () => {
    const rule = learning({ statement: "Never force-push to main.", subject: "force-push", level: "L3", polarity: "deny" });
    const skill = learning({ statement: "Force-push is fine on feature branches.", subject: "force-push", level: "L2", polarity: "affirm" });
    const conflicts = detectCrossLevelConflicts([rule, skill]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.subject).toBe("force-push");
  });

  it("decaySweep integrates supersession + staleness + conflicts", () => {
    const keep = learning({ statement: "Recent useful finance learning.", subject: "f1" });
    const stale = learning({ statement: "Stale uncited learning here.", subject: "f2", createdAt: daysAgo(40) });
    const sweep = decaySweep([keep, stale], NOW, { reviewAfterDays: 14, pruneAfterDays: 28 });
    expect(sweep.keep.map((l) => l.id)).toContain(keep.id);
    expect(sweep.prune.map((l) => l.id)).toContain(stale.id);
  });
});

describe("DECAY by SESSION (the real clock, §8/v0.17)", () => {
  const days = { reviewAfterDays: 14, pruneAfterDays: 28 };
  const sessionCtx = (currentSession: number) => ({ currentSession, reviewAfterSessions: 8, pruneAfterSessions: 16 });

  it("idleSessions counts sessions since last cite (or creation)", () => {
    expect(idleSessions(learning({ statement: "x learning here now", subject: "a", createdSession: 2 }), 10)).toBe(8);
    expect(idleSessions(learning({ statement: "x learning here now", subject: "a", createdSession: 2, lastCitedSession: 9 }), 10)).toBe(1);
  });

  it("classifyDecay prefers the SESSION clock when session data is present", () => {
    const l = learning({ statement: "session-tracked learning here", subject: "s", createdSession: 1 });
    expect(classifyDecay(l, NOW, days, sessionCtx(5))).toBe("keep"); // idle 4
    expect(classifyDecay(l, NOW, days, sessionCtx(12))).toBe("review"); // idle 11 > 8
    expect(classifyDecay(l, NOW, days, sessionCtx(20))).toBe("prune"); // idle 19 > 16
  });

  it("falls back to the DAYS clock when the learning predates the session counter", () => {
    // createdSession 0 (no session data) → days path used even with a session ctx.
    const old = learning({ statement: "pre-counter learning here", subject: "p", createdAt: daysAgo(40), createdSession: 0 });
    expect(classifyDecay(old, NOW, days, sessionCtx(1))).toBe("prune"); // 40d > 28d
  });

  it("citeLearning stamps the session when given one", () => {
    const cited = citeLearning(learning({ statement: "cite me by session please", subject: "c" }), { at: daysAgo(0), outcome: "used" }, 42);
    expect(cited.lastCitedSession).toBe(42);
  });
});

describe("PROMOTE — the L0→L3 diagonal (§8)", () => {
  const thresholds = { promoteToSkill: 2, promoteToRule: 4, demoteAfterSessions: 12 };
  const cites = (n: number) => Array.from({ length: n }, (_, i) => ({ at: daysAgo(i), outcome: "used" }));

  it("ACCEPTANCE: a VALIDATED, sufficiently-cited L1 promotes to L2 (a skill), with a re-hashed id", () => {
    const l1 = learning({ statement: "Reconcile the ledger before close.", subject: "ledger", level: "L1", validated: true, citations: cites(2), lastCitedSession: 10 });
    const result = promoteSweep([l1], 10, thresholds);
    expect(result.promoted).toHaveLength(1);
    const change = result.promoted[0]!;
    expect(change.from).toBe("L1");
    expect(change.to).toBe("L2");
    expect(change.learning.level).toBe("L2");
    expect(change.learning.id).not.toBe(change.oldId); // id is re-hashed for the new level
    expect(change.oldId).toBe(l1.id);
  });

  it("a VALIDATED, widely-cited L2 promotes to L3 (a rule)", () => {
    const l2 = learning({ statement: "Never force-push to a shared branch.", subject: "force-push", level: "L2", validated: true, citations: cites(4), lastCitedSession: 9 });
    const result = promoteSweep([l2], 10, thresholds);
    expect(result.promoted[0]).toMatchObject({ from: "L2", to: "L3" });
  });

  it("the GATE is the point: a self-generated (unvalidated) learning NEVER promotes, no matter how cited", () => {
    const selfGen = learning({ statement: "Tool X was useful for the app suit.", subject: "x", level: "L1", validated: false, citations: cites(9), lastCitedSession: 10 });
    const result = promoteSweep([selfGen], 10, thresholds);
    expect(result.promoted).toHaveLength(0);
    expect(result.unchanged.map((l) => l.id)).toContain(selfGen.id);
  });

  it("an uncited skill DEMOTES (L2 → L1) after the idle threshold — demotion beats promotion", () => {
    // Validated L2 with citations but idle far past the demote window → demote first.
    const stale = learning({ statement: "An old skill nobody uses anymore now.", subject: "old", level: "L2", validated: true, citations: cites(4), createdSession: 1, lastCitedSession: 2 });
    const result = promoteSweep([stale], 20, thresholds); // idle = 18 > 12
    expect(result.demoted[0]).toMatchObject({ from: "L2", to: "L1" });
    expect(result.promoted).toHaveLength(0);
  });

  it("nothing changes when neither threshold is met", () => {
    const fresh = learning({ statement: "A validated learning with one citation.", subject: "f", level: "L1", validated: true, citations: cites(1), lastCitedSession: 10 });
    expect(promoteSweep([fresh], 10, thresholds).unchanged).toHaveLength(1);
  });
});
