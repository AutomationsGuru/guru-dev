import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { CriticPanelConfigSchema, type CriticPanelConfig } from "../config/schema.js";
import { commandExists, type NativeReviewer } from "../review/gates.js";
import { makeNativeReviewer, type AskModel, type NativeReviewContext } from "../review/nativeCriticPanel.js";
import { createTypeScriptLanguageServerAdapter } from "../lsp/typescriptLanguageServer.js";

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

/** Gather uncommitted changes (`git diff HEAD`) as the review context. git-absent / no diff → empty.
 * Optionally attach LSP diagnostics for changed files when attachLspDiagnostics=true (read-only, safe for YOLO). */
export function makeGitDiffGatherer(input: {
  readonly objective?: string;
  readonly runGit?: GitRunner;
  readonly commandExists?: (name: string) => boolean;
  readonly attachLspDiagnostics?: boolean;
} = {}): ReviewContextGatherer {
  const runGit = input.runGit ?? defaultGitRunner;
  const exists = input.commandExists ?? commandExists;
  return async (cwd) => {
    const dir = cwd ?? process.cwd();
    const diff = exists("git") ? runGit(["diff", "HEAD"], dir) : "";
    const base = { diff, ...(input.objective ? { objective: input.objective } : {}) };
    if (input.attachLspDiagnostics && diff && diff.trim()) {
      try {
        const adapter = createTypeScriptLanguageServerAdapter();
        const fileRe = /^\+\+\+ b\/(.+?)$/gm;
        const files = Array.from(diff.matchAll(fileRe)).map((m) => m[1]).filter((f): f is string => typeof f === "string" && /\.(ts|tsx|js|jsx)$/.test(f));
        const lspDiags: Array<{ file: string; diagnostics: readonly unknown[] }> = [];
        for (const f of files.slice(0, 6)) {
          try {
            const diags = await adapter.diagnostics({ repoRoot: dir, filePath: resolve(dir, f) });
            if (diags.length > 0) lspDiags.push({ file: f, diagnostics: diags });
          } catch {
            // per-file fail: ignore (file may be new/deleted or LSP partial)
          }
        }
        if (lspDiags.length > 0) {
          return { ...base, lspDiagnostics: lspDiags } as NativeReviewContext;
        }
      } catch {
        // LSP unavailable or adapter error: degrade gracefully, preserve diff-only behavior
      }
    }
    return base as NativeReviewContext;
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
