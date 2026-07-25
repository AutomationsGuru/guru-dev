// Work ID: IDEA-F160-COMPLETION-GATE-01
// Tests: model-done alone never completes; all gates pass completes;
// one failing gate blocks and reports which gate failed and why.

import { describe, expect, it } from "vitest";

import {
  CompletionGateSchema,
  CompletionAttemptResultSchema
} from '../../src/runtime/completionGateLoopSchema.js';
import {
  evaluateCompletionGates,
  tryComplete,
  type CompletionGateContext
} from '../../src/runtime/completionGateLoop.js';
import type { CompletionGate } from '../../src/runtime/completionGateLoopSchema.js';

const filesExistGate: CompletionGate = CompletionGateSchema.parse({
  id: "required-files",
  kind: "files-exist",
  params: { paths: ["src/app.ts", "README.md"] }
});

const commandGate: CompletionGate = CompletionGateSchema.parse({
  id: "tests-green",
  kind: "command-exit-zero",
  params: { command: "npm test" }
});

const approvalGate: CompletionGate = CompletionGateSchema.parse({
  id: "operator-signoff",
  kind: "operator-approved",
  params: {}
});

function makeContext(overrides: Partial<CompletionGateContext> = {}): CompletionGateContext {
  return {
    fileExists: () => true,
    runCommand: async () => ({ exitCode: 0 }),
    operatorApproved: true,
    ...overrides
  };
}

describe("completionGateLoop", () => {
  it("should not complete on model self-report alone when gates fail", async () => {
    const result = await tryComplete(
      [filesExistGate, commandGate, approvalGate],
      makeContext({
        modelReportedDone: true,
        fileExists: () => false,
        runCommand: async () => ({ exitCode: 1 }),
        operatorApproved: false
      })
    );

    expect(result.completed).toBe(false);
    expect(result.modelReportedDone).toBe(true);
    expect(result.evaluation.failed).toHaveLength(3);
  });

  it("should not complete on model self-report with no gates at all", async () => {
    const result = await tryComplete([], makeContext({ modelReportedDone: true }));

    expect(result.completed).toBe(false);
    expect(result.evaluation.passed).toHaveLength(0);
    expect(result.evaluation.failed).toHaveLength(0);
  });

  it("should complete when every gate passes", async () => {
    const result = await tryComplete(
      [filesExistGate, commandGate, approvalGate],
      makeContext({ modelReportedDone: true })
    );

    expect(CompletionAttemptResultSchema.parse(result)).toEqual(result);
    expect(result.completed).toBe(true);
    expect(result.evaluation.passed).toEqual(["required-files", "tests-green", "operator-signoff"]);
    expect(result.evaluation.failed).toEqual([]);
  });

  it("should block completion when one gate fails and report which gate and why", async () => {
    const result = await tryComplete(
      [filesExistGate, commandGate, approvalGate],
      makeContext({ runCommand: async () => ({ exitCode: 2 }) })
    );

    expect(result.completed).toBe(false);
    expect(result.evaluation.passed).toEqual(["required-files", "operator-signoff"]);
    expect(result.evaluation.failed).toEqual([
      { id: "tests-green", kind: "command-exit-zero", reason: "command exited with code 2: npm test" }
    ]);
  });

  it("should report the missing file path when a files-exist gate fails", async () => {
    const evaluation = await evaluateCompletionGates(
      [filesExistGate],
      makeContext({ fileExists: (path) => path !== "README.md" })
    );

    expect(evaluation.passed).toEqual([]);
    expect(evaluation.failed).toEqual([
      { id: "required-files", kind: "files-exist", reason: "required file missing: README.md" }
    ]);
  });

  it("should block an operator-approved gate without operator approval", async () => {
    const evaluation = await evaluateCompletionGates([approvalGate], makeContext({ operatorApproved: false }));

    expect(evaluation.failed).toEqual([
      { id: "operator-signoff", kind: "operator-approved", reason: "operator approval not granted" }
    ]);
  });
});
