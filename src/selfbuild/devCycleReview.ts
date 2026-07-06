import { execFileSync } from "node:child_process";

import { CriticPanelConfigSchema, type CriticPanelConfig } from "../config/schema.js";
import { commandExists, type NativeReviewer } from "../review/gates.js";
import { makeNativeReviewer, type AskModel, type NativeReviewContext } from "../review/nativeCriticPanel.js";

/**
 * Wire guru's LIVE native critic panel into the dev cycle (P7). Given a single-turn
 * `askModel`, this builds the `nativeReviewer` runDevCycle's REVIEW stage runs — so REVIEW
 * actually reviews the change (and a RED verdict blocks SHIP) instead of degrading to YELLOW.
 * The review context is the uncommitted diff; critics see ONLY that + the objective, so they
 * stay read-only by construction. git runner is injectable for tests.
 */

export type ReviewContextGatherer = (cwd?: string) => Promise<NativeReviewContext>;
export type GitRunner = (args: readonly string[], cwd: string) => string;

const DEFAULT_PANEL: CriticPanelConfig = CriticPanelConfigSchema.parse({});

const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

/** Gather uncommitted changes (`git diff HEAD`) as the review context. git-absent / no diff → empty. */
export function makeGitDiffGatherer(input: {
  readonly objective?: string;
  readonly runGit?: GitRunner;
  readonly commandExists?: (name: string) => boolean;
} = {}): ReviewContextGatherer {
  const runGit = input.runGit ?? defaultGitRunner;
  const exists = input.commandExists ?? commandExists;
  return async (cwd) => {
    const dir = cwd ?? process.cwd();
    const diff = exists("git") ? runGit(["diff", "HEAD"], dir) : "";
    return { diff, ...(input.objective ? { objective: input.objective } : {}) };
  };
}

export interface MakeDevCycleReviewerInput {
  readonly askModel?: AskModel;
  readonly panel?: CriticPanelConfig;
  readonly getReviewContext?: ReviewContextGatherer;
  readonly objective?: string;
}

/** Build guru's live native reviewer from an askModel; `undefined` when no model is available. */
export function makeDevCycleReviewer(input: MakeDevCycleReviewerInput): NativeReviewer | undefined {
  if (!input.askModel) {
    return undefined;
  }
  return makeNativeReviewer({
    askModel: input.askModel,
    panel: input.panel ?? DEFAULT_PANEL,
    getReviewContext:
      input.getReviewContext ?? makeGitDiffGatherer(input.objective ? { objective: input.objective } : {})
  });
}
