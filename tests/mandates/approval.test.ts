import { describe, expect, it } from "vitest";

import { resolveApproval, type ApprovalChoice, type ApprovalRequest } from "../../src/mandates/approval.js";
import type { MandateDecision } from "../../src/mandates/evaluate.js";
import type { MandateVerb } from "../../src/mandates/schema.js";

function decision(outcome: MandateDecision["outcome"], verbs: MandateVerb[]): MandateDecision {
  return { outcome, verbs, reason: `${outcome} (${verbs.join("+")})` };
}

/** A prompt stub: records the requests it received and returns a fixed choice. */
function stubPrompt(choice: ApprovalChoice) {
  const seen: ApprovalRequest[] = [];
  const prompt = async (request: ApprovalRequest): Promise<ApprovalChoice> => {
    seen.push(request);
    return choice;
  };
  return { prompt, seen };
}

describe("resolveApproval — the per-call gate (§12 / §2.3)", () => {
  it("allow → true and deny → false without ever prompting", async () => {
    const { prompt, seen } = stubPrompt("deny");
    expect(await resolveApproval("write", decision("allow", ["write"]), { sessionApprovals: new Set(), prompt })).toBe(true);
    expect(await resolveApproval("write", decision("deny", ["write"]), { sessionApprovals: new Set(), prompt })).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("escalate → prompts; 'once' allows this call but grants nothing for the session", async () => {
    const approvals = new Set<MandateVerb>();
    const { prompt, seen } = stubPrompt("once");
    expect(await resolveApproval("write", decision("escalate", ["write"]), { sessionApprovals: approvals, prompt })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolId: "write", hardEdge: false, allowAlways: true });
    expect(approvals.has("write")).toBe(false); // "once" grants nothing
  });

  it("escalate → 'always' allows AND grants the verbs for the session (no re-prompt after)", async () => {
    const approvals = new Set<MandateVerb>();
    const always = stubPrompt("always");
    expect(await resolveApproval("write", decision("escalate", ["write"]), { sessionApprovals: approvals, prompt: always.prompt })).toBe(true);
    expect(approvals.has("write")).toBe(true);
    // A subsequent same-verb escalation passes WITHOUT prompting.
    const next = stubPrompt("deny");
    expect(await resolveApproval("edit", decision("escalate", ["write"]), { sessionApprovals: approvals, prompt: next.prompt })).toBe(true);
    expect(next.seen).toHaveLength(0);
  });

  it("escalate → 'deny' blocks the call", async () => {
    const { prompt } = stubPrompt("deny");
    expect(await resolveApproval("bash", decision("escalate", ["exec"]), { sessionApprovals: new Set(), prompt })).toBe(false);
  });

  it("F3 (fail-open fix): an UNEXPECTED prompt result default-DENIES, never the old blanket approve", async () => {
    for (const bad of ["", "n", "no", "yes", undefined] as unknown as ApprovalChoice[]) {
      const prompt = async (): Promise<ApprovalChoice> => bad;
      expect(await resolveApproval("write", decision("escalate", ["write"]), { sessionApprovals: new Set(), prompt })).toBe(false);
    }
    // the two EXPLICIT approvals still pass (regression guard)
    expect(await resolveApproval("write", decision("escalate", ["write"]), { sessionApprovals: new Set(), prompt: stubPrompt("once").prompt })).toBe(true);
    expect(await resolveApproval("write", decision("escalate", ["write"]), { sessionApprovals: new Set(), prompt: stubPrompt("always").prompt })).toBe(true);
  });

  it("ACCEPTANCE: a HARD EDGE always prompts — even when the verb was session-approved — and 'always' does not persist", async () => {
    const approvals = new Set<MandateVerb>(["destructive"]); // pretend it was granted
    const { prompt, seen } = stubPrompt("always");
    // Still prompts despite the session grant (hard edges bypass the shortcut).
    expect(await resolveApproval("bash", decision("escalate", ["exec", "destructive"]), { sessionApprovals: approvals, prompt })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ hardEdge: true, allowAlways: false });
    // "always" on a hard edge grants nothing — it must prompt again next time.
    expect([...approvals]).toEqual(["destructive"]); // unchanged (exec NOT added)
    const again = stubPrompt("deny");
    expect(await resolveApproval("bash", decision("escalate", ["destructive"]), { sessionApprovals: approvals, prompt: again.prompt })).toBe(false);
    expect(again.seen).toHaveLength(1); // prompted again
  });
});
