// Work ID: IDEA-F160-COMPLETION-GATE-01
// Completion gate loop: evaluate pure predicates against an injected context
// and complete only when every gate passes. Model self-report alone never
// completes. All I/O is injected via the context so tests are hermetic.

import type {
  CompletionAttemptResult,
  CompletionGate,
  CompletionGateEvaluation,
  CompletionGateFailure
} from "./completionGateLoopSchema.js";

export interface CommandResult {
  exitCode: number;
}

export interface CompletionGateContext {
  /** Model self-report that the task is done. Never sufficient on its own. */
  modelReportedDone?: boolean;
  /** Whether the operator has explicitly approved completion. */
  operatorApproved?: boolean;
  /** Injected existence check for the files-exist gate. */
  fileExists: (path: string) => boolean | Promise<boolean>;
  /** Injected command runner for the command-exit-zero gate. */
  runCommand: (command: string) => Promise<CommandResult>;
}

export async function evaluateCompletionGates(
  gates: readonly CompletionGate[],
  context: CompletionGateContext
): Promise<CompletionGateEvaluation> {
  const passed: string[] = [];
  const failed: CompletionGateFailure[] = [];

  for (const gate of gates) {
    const failure = await evaluateGate(gate, context);
    if (failure) {
      failed.push(failure);
    } else {
      passed.push(gate.id);
    }
  }

  return { passed, failed };
}

export async function tryComplete(
  gates: readonly CompletionGate[],
  context: CompletionGateContext
): Promise<CompletionAttemptResult> {
  const evaluation = await evaluateCompletionGates(gates, context);

  return {
    completed: evaluation.failed.length === 0 && evaluation.passed.length > 0,
    modelReportedDone: context.modelReportedDone === true,
    evaluation
  };
}

async function evaluateGate(gate: CompletionGate, context: CompletionGateContext): Promise<CompletionGateFailure | undefined> {
  switch (gate.kind) {
    case "files-exist": {
      for (const path of gate.params.paths) {
        const exists = await context.fileExists(path);
        if (!exists) {
          return { id: gate.id, kind: gate.kind, reason: `required file missing: ${path}` };
        }
      }
      return undefined;
    }
    case "command-exit-zero": {
      const result = await context.runCommand(gate.params.command);
      if (result.exitCode !== 0) {
        return {
          id: gate.id,
          kind: gate.kind,
          reason: `command exited with code ${result.exitCode}: ${gate.params.command}`
        };
      }
      return undefined;
    }
    case "operator-approved": {
      if (context.operatorApproved !== true) {
        return { id: gate.id, kind: gate.kind, reason: "operator approval not granted" };
      }
      return undefined;
    }
  }
}
