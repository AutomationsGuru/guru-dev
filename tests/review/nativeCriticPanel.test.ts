import { describe, expect, it, vi } from "vitest";

import { CriticPanelConfigSchema, HarnessConfigSchema } from "../../src/config/schema.js";
import { runReviewGates, type CommandExecutor } from "../../src/review/gates.js";
import { makeNativeReviewer, runNativeCriticPanel, type AskModel, type CriticFinding } from "../../src/review/nativeCriticPanel.js";

const panel = (over = {}) => CriticPanelConfigSchema.parse(over);

/** Stub model: FIND returns canned findings per persona; VERIFY confirms unless the finding summary carries "REFUTEME". */
function stubModel(findingsByPersona: Record<string, Array<Partial<CriticFinding>>> = {}): { askModel: AskModel; calls: () => number } {
  let n = 0;
  const askModel: AskModel = async (prompt, meta) => {
    n += 1;
    if (meta.phase === "find") {
      return `here are findings:\n${JSON.stringify(findingsByPersona[meta.persona] ?? [])}`;
    }
    return JSON.stringify({ confirmed: !prompt.includes("REFUTEME"), reason: "test" });
  };
  return { askModel, calls: () => n };
}

const ctx = { diff: "some code change", objective: "do the thing" };

describe("native critic panel (P1) — guru's OWN model-powered review, read-only + code-synthesized", () => {
  it("clean diff → GREEN, one FIND call per persona, no VERIFY calls", async () => {
    const model = stubModel();
    const result = await runNativeCriticPanel(ctx, { askModel: model.askModel, panel: panel() });
    expect(result.verdict).toBe("GREEN");
    expect(result.findings).toHaveLength(0);
    expect(result.usage).toBeUndefined(); // legacy string responses carry no invented usage
    expect(model.calls()).toBe(4); // 4 personas, nothing to verify
  });

  it("aggregates every completed FIND and VERIFY response exactly once", async () => {
    const askModel: AskModel = async (_prompt, meta) => {
      if (meta.phase === "find") {
        return {
          text:
            meta.persona === "security"
              ? JSON.stringify([{ severity: "high", summary: "false positive", failureScenario: "test" }])
              : "[]",
          usage: { input: 10, output: 1 }
        };
      }
      return {
        text: JSON.stringify({ confirmed: false, reason: "refuted" }),
        usage: { input: 7, output: 2 }
      };
    };

    const result = await runNativeCriticPanel(ctx, { askModel, panel: panel() });

    expect(result.verdict).toBe("GREEN");
    expect(result.refutedCount).toBe(1);
    expect(result.usage).toEqual({ input: 47, output: 6 });
  });

  it("counts fulfilled FIND usage once when VERIFY throws and keeps the finding fail-safe", async () => {
    const askModel: AskModel = async (_prompt, meta) => {
      if (meta.phase === "verify") {
        throw new Error("provider unavailable");
      }
      return {
        text:
          meta.persona === "security"
            ? JSON.stringify([{ severity: "high", summary: "real issue", failureScenario: "test" }])
            : "[]",
        usage: { input: 2, output: 1 }
      };
    };

    const result = await runNativeCriticPanel(ctx, { askModel, panel: panel() });

    expect(result.verdict).toBe("RED");
    expect(result.findings).toHaveLength(1);
    expect(result.usage).toEqual({ input: 8, output: 4 });
  });

  it("a CONFIRMED high finding → RED", async () => {
    const model = stubModel({ security: [{ severity: "high", summary: "hardcoded key leak", failureScenario: "cat .env leaks" }] });
    const result = await runNativeCriticPanel(ctx, { askModel: model.askModel, panel: panel() });
    expect(result.verdict).toBe("RED");
    expect(result.findings[0]?.severity).toBe("high");
  });

  it("a high finding that VERIFY refutes → GREEN (can't rubber-stamp, but also drops false positives)", async () => {
    const model = stubModel({ correctness: [{ severity: "high", summary: "off-by-one REFUTEME", failureScenario: "n/a" }] });
    const result = await runNativeCriticPanel(ctx, { askModel: model.askModel, panel: panel() });
    expect(result.verdict).toBe("GREEN");
    expect(result.refutedCount).toBe(1);
  });

  it("a CONFIRMED medium-only finding → YELLOW", async () => {
    const model = stubModel({ simplicity: [{ severity: "medium", summary: "dead code", failureScenario: "x" }] });
    const result = await runNativeCriticPanel(ctx, { askModel: model.askModel, panel: panel() });
    expect(result.verdict).toBe("YELLOW");
  });

  it("respects the worker budget (find + verify calls never exceed maxWorkers)", async () => {
    const model = stubModel({ security: [{ severity: "high", summary: "a", failureScenario: "x" }], correctness: [{ severity: "high", summary: "b", failureScenario: "x" }] });
    const result = await runNativeCriticPanel(ctx, { askModel: model.askModel, panel: panel({ maxWorkers: 2 }) });
    expect(model.calls()).toBeLessThanOrEqual(2);
    expect(result.verdict).toBe("RED"); // budget-exhausted findings are KEPT (fail-safe), not dropped
  });

  it("the panel takes ONLY a model call — no tools, no executor (read-only by construction)", async () => {
    // The function signature admits nothing but askModel + panel; a critic cannot write or exec.
    const model = stubModel({ security: [{ severity: "high", summary: "x", failureScenario: "y" }] });
    await runNativeCriticPanel(ctx, { askModel: model.askModel, panel: panel() });
    expect(model.calls()).toBeGreaterThan(0); // the only side-channel is the model call
  });
});

describe("native review wired into runReviewGates (replaces review, zero external calls)", () => {
  const config = HarnessConfigSchema.parse({}); // default reviewGate = native-critic-panel, no validation commands

  it("default config runs the NATIVE gate through the injected reviewer — the shell executor is never called", async () => {
    const model = stubModel({ security: [{ severity: "high", summary: "leak", failureScenario: "cat .env" }] });
    const reviewer = makeNativeReviewer({ askModel: model.askModel, panel: panel(), getReviewContext: async () => ctx });
    const executor = vi.fn<CommandExecutor>(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }));
    const report = await runReviewGates(config, { nativeReviewer: reviewer, executor });
    expect(report.verdict).toBe("RED"); // the seeded confirmed-high blocks
    expect(executor).not.toHaveBeenCalled(); // NO external tool invoked
  });

  it("a clean diff through the native gate → GREEN, still zero external calls", async () => {
    const model = stubModel();
    const reviewer = makeNativeReviewer({ askModel: model.askModel, panel: panel(), getReviewContext: async () => ctx });
    const executor = vi.fn<CommandExecutor>(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }));
    const report = await runReviewGates(config, { nativeReviewer: reviewer, executor });
    expect(report.verdict).toBe("GREEN");
    expect(executor).not.toHaveBeenCalled();
  });

  it("native gate with NO reviewer wired → YELLOW (honest 'not run'), never RED-by-absence", async () => {
    const report = await runReviewGates(config, {}); // no nativeReviewer
    expect(report.verdict).toBe("YELLOW");
  });
});
