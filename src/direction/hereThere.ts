import { z } from "zod";

import type { SelfBuildTask } from "../kernel/selfBuildLoop.js";

export type DirectionVerdict = "GREEN" | "YELLOW" | "RED";
export type DirectionCheckStatus = "passed" | "warning" | "failed";

export const HereThereDefinitionSchema = z
  .object({
    here: z.string().trim().min(40),
    there: z.string().trim().min(40)
  })
  .strict();
export type HereThereDefinition = z.infer<typeof HereThereDefinitionSchema>;

export const DirectionAlignmentTaskSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    thereContribution: z.string().trim().min(1)
  })
  .strict();
export type DirectionAlignmentTask = z.infer<typeof DirectionAlignmentTaskSchema>;

export interface DirectionCheck {
  readonly id: string;
  readonly title: string;
  readonly status: DirectionCheckStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface DirectionAlignmentReport extends HereThereDefinition {
  readonly verdict: DirectionVerdict;
  readonly task?: DirectionAlignmentTask;
  readonly checks: readonly DirectionCheck[];
  readonly summary: string;
}

export interface CreateDirectionAlignmentReportOptions extends HereThereDefinition {
  readonly task?: SelfBuildTask | DirectionAlignmentTask;
}

const thereRequiredPhrases = ["independent agent harness", "self-building"];
const contributionKeywords = [
  "harness",
  "runtime",
  "session",
  "tool",
  "skill",
  "memory",
  "repo",
  "config",
  "policy",
  "model",
  "cli",
  "api",
  "tui",
  "supabase",
  "github",
  "review",
  "validation"
];

export function createDirectionAlignmentReport(options: CreateDirectionAlignmentReportOptions): DirectionAlignmentReport {
  const hereThere = HereThereDefinitionSchema.parse({ here: options.here, there: options.there });
  const task = options.task
    ? DirectionAlignmentTaskSchema.parse({
        id: options.task.id,
        title: options.task.title,
        description: options.task.description,
        thereContribution: options.task.thereContribution
      })
    : undefined;
  const checks = [checkHere(hereThere.here), checkThere(hereThere.there), checkTaskContribution(task)];
  const verdict = deriveDirectionVerdict(checks);

  return {
    ...hereThere,
    verdict,
    ...(task ? { task } : {}),
    checks,
    summary: `${verdict}: HERE/THERE direction ${verdict === "GREEN" ? "is aligned" : "needs attention"}.`
  };
}

function checkHere(here: string): DirectionCheck {
  const forbiddenStaleClaims = ["no open prs remain", "being added"];
  const lowerHere = here.toLowerCase();
  const staleClaims = forbiddenStaleClaims.filter((claim) => lowerHere.includes(claim));

  if (staleClaims.length > 0) {
    return {
      id: "here-current",
      title: "HERE reflects current state",
      status: "warning",
      summary: `HERE may contain stale claim(s): ${staleClaims.join(", ")}.`,
      evidence: staleClaims
    };
  }

  return {
    id: "here-current",
    title: "HERE reflects current state",
    status: "passed",
    summary: "HERE is defined as the current GuruHarness substrate state.",
    evidence: [here]
  };
}

function checkThere(there: string): DirectionCheck {
  const lowerThere = there.toLowerCase();
  const missingPhrases = thereRequiredPhrases.filter((phrase) => !lowerThere.includes(phrase));

  if (missingPhrases.length > 0) {
    return {
      id: "there-target",
      title: "THERE defines the correct product target",
      status: "failed",
      summary: `THERE is missing required target phrase(s): ${missingPhrases.join(", ")}.`,
      evidence: missingPhrases
    };
  }

  return {
    id: "there-target",
    title: "THERE defines the correct product target",
    status: "passed",
    summary: "THERE is a working independent agent harness with self-building capability, not merely a self-build loop.",
    evidence: [there]
  };
}

function checkTaskContribution(task: DirectionAlignmentTask | undefined): DirectionCheck {
  if (!task) {
    return {
      id: "task-there-contribution",
      title: "Task moves GuruHarness toward THERE",
      status: "warning",
      summary: "No task was supplied for direction alignment.",
      evidence: []
    };
  }

  const lowerContribution = task.thereContribution.toLowerCase();
  const matchedKeywords = contributionKeywords.filter((keyword) => lowerContribution.includes(keyword));

  if (matchedKeywords.length === 0) {
    return {
      id: "task-there-contribution",
      title: "Task moves GuruHarness toward THERE",
      status: "failed",
      summary: "Task has no explicit contribution tied to independent agent harness capabilities.",
      evidence: [task.id, task.thereContribution]
    };
  }

  return {
    id: "task-there-contribution",
    title: "Task moves GuruHarness toward THERE",
    status: "passed",
    summary: `Task ${task.id} declares how it moves toward THERE.`,
    evidence: [task.thereContribution, ...matchedKeywords]
  };
}

function deriveDirectionVerdict(checks: readonly DirectionCheck[]): DirectionVerdict {
  if (checks.some((check) => check.status === "failed")) {
    return "RED";
  }

  if (checks.some((check) => check.status === "warning")) {
    return "YELLOW";
  }

  return "GREEN";
}
