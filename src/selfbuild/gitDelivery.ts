import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MandatePolicyFn } from "../executor/selfBuildExecutor.js";
import { ChangeRecordSchema, type ChangeRecord, type GitDeliveryContext, type ShipStageResult } from "./shipStage.js";

/**
 * Gated git delivery (self-build P5/P7) — routes the push THROUGH the mandate gate before
 * running it, closing the verified hole where the ship path called git directly and bypassed
 * the spend/deploy hard-edge. A push is evaluated as a deploy action: under the fail-closed
 * autonomous policy (no grant) it escalates → we degrade to a durable on-disk change-record
 * and NEVER push unapproved; with an explicit grant it commits + pushes. git runner injectable.
 */

export interface GatedGitDeliveryDeps {
  readonly cwd: string;
  readonly policy: MandatePolicyFn;
  readonly payload: ChangeRecord;
  readonly commitMessage?: string;
  readonly branchName?: string;
  readonly runGit: (args: readonly string[], cwd: string) => { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
  readonly writeChangeRecord?: (record: ChangeRecord, path: string) => void;
  readonly changeRecordDir?: string;
}

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "task";
}

function writeLocalRecord(deps: GatedGitDeliveryDeps): string {
  const record = ChangeRecordSchema.parse(deps.payload);
  const dir = deps.changeRecordDir ?? join(deps.cwd, ".guru", "change-records");
  const recordPath = join(dir, `${slugify(record.taskId)}.json`);
  if (deps.writeChangeRecord) {
    deps.writeChangeRecord(record, recordPath);
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
  return recordPath;
}

export function makeGatedGitDelivery(deps: GatedGitDeliveryDeps): (ctx: GitDeliveryContext) => Promise<ShipStageResult> {
  const branch = deps.branchName ?? "HEAD";
  return async (ctx) => {
    // The push is a deploy action — evaluate it through the mandate gate FIRST.
    const decision = deps.policy("bash", { command: `git push origin ${branch}` }, deps.cwd);
    if (decision && decision.outcome !== "allow") {
      const recordPath = writeLocalRecord(deps);
      return {
        verdict: "YELLOW",
        target: "local-record",
        evidence: `git push gated (${decision.outcome}: ${decision.reason}) — wrote a durable change-record instead of pushing unapproved`,
        recordPath
      };
    }

    const commit = deps.runGit(["commit", "-am", deps.commitMessage ?? "chore: self-build delivery"], deps.cwd);
    if (commit.exitCode !== 0) {
      const out = `${commit.stdout}\n${commit.stderr}`;
      // A clean tree / no staged change is a legible no-op, NOT a GREEN ship — record it honestly.
      if (/nothing to commit|no changes added|nothing added to commit/iu.test(out)) {
        const recordPath = writeLocalRecord(deps);
        return { verdict: "YELLOW", target: "local-record", evidence: "git commit produced no change (nothing to commit) — nothing shipped", recordPath };
      }
      return { verdict: "RED", target: "git", evidence: `git commit failed: ${commit.stderr || `exit ${commit.exitCode}`}` };
    }
    const push = deps.runGit(["push", "origin", branch], deps.cwd);
    if (push.exitCode !== 0) {
      return { verdict: "RED", target: "git", evidence: `git push failed: ${push.stderr || `exit ${push.exitCode}`}` };
    }
    return { verdict: "GREEN", target: ctx.ghPresent ? "git+pr" : "git", evidence: `committed + pushed to ${branch}` };
  };
}
