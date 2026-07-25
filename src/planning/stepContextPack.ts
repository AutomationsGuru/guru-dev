import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  StepContextPackSchema,
  StepContextPlanSchema,
  StepContextStepSchema
} from "./stepContextSchema.js";
import type { StepContextPack, StepContextPlan } from "./stepContextSchema.js";

/**
 * IDEA-F7-STEP-CTX-01 — per-step context pack builder (R-PD-STEP-CTX).
 *
 * Multi-step plan runs inject only the files declared relevant to the
 * *current* step, plus the always-on hard context set (the AGENTS chain and
 * the mandates sources that encode the constitution in code). This keeps
 * per-step prompt weight down without ever dropping the hard context the
 * harness must always operate under.
 *
 * Pure builder: `buildStepContextPack` takes already-parsed descriptors and
 * returns a typed pack. `resolveAlwaysOnPaths` is the only filesystem touch —
 * it filters the candidate always-on set down to files that actually exist
 * under a repository root, so a missing optional file is dropped honestly
 * rather than invented.
 */

export {
  StepContextPackSchema,
  StepContextPlanSchema,
  StepContextStepSchema
} from "./stepContextSchema.js";
export type {
  StepContextPack,
  StepContextPlan,
  StepContextStep
} from "./stepContextSchema.js";

/**
 * Candidate always-on hard context, in injection order. The AGENTS chain is
 * the binding DOX contract; the mandates sources encode the constitution in
 * code. Both are mandatory on every step — never traded away for brevity.
 * `resolveAlwaysOnPaths` drops entries that do not exist under a given root.
 */
export const DEFAULT_ALWAYS_ON_PATTERNS: readonly string[] = [
  "AGENTS.md",
  "src/AGENTS.md",
  "src/mandates/schema.ts",
  "src/mandates/evaluate.ts",
  "src/mandates/approval.ts",
  "src/mandates/preservation.ts",
  "src/mandates/store.ts"
];

export interface BuildStepContextPackOptions {
  readonly plan: StepContextPlan;
  readonly stepId: string;
  readonly alwaysOnPaths: readonly string[];
}

/**
 * Build the inject pack for the active step. The pack contains exactly the
 * active step's declared `relevantPaths` (never another step's files) plus
 * the always-on hard context set. Fails closed on an unknown step id.
 */
export function buildStepContextPack(options: BuildStepContextPackOptions): StepContextPack {
  const plan = StepContextPlanSchema.parse(options.plan);
  const step = plan.steps.find((candidate) => candidate.id === options.stepId);

  if (!step) {
    throw new Error(
      `buildStepContextPack: unknown step id "${options.stepId}" (known: ${plan.steps
        .map((candidate) => candidate.id)
        .join(", ")})`
    );
  }

  const pack = {
    stepId: step.id,
    stepFiles: [...step.relevantPaths],
    alwaysOnFiles: dedupePreservingOrder(options.alwaysOnPaths),
    ...(step.notes !== undefined ? { notes: step.notes } : {})
  };

  return StepContextPackSchema.parse(pack);
}

export interface ResolveAlwaysOnPathsOptions {
  readonly rootPath: string;
  readonly patterns?: readonly string[];
}

/**
 * Resolve the always-on hard context set against a repository root, keeping
 * only files that exist on disk. Result paths are repo-relative, ordered as
 * the input patterns, and deduplicated.
 */
export function resolveAlwaysOnPaths(options: ResolveAlwaysOnPathsOptions): readonly string[] {
  const rootPath = resolve(options.rootPath);
  const patterns = options.patterns ?? DEFAULT_ALWAYS_ON_PATTERNS;

  return dedupePreservingOrder(
    patterns.filter((pattern) => existsSync(join(rootPath, pattern)))
  );
}

function dedupePreservingOrder(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }

  return result;
}
