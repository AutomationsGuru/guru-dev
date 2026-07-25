import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import { resolveGuruHomeDirectory } from "../home/paths.js";

/**
 * Project law — repo (and optional home) PATH-GLOB WRITE HOLDS that the tool
 * gate enforces EVEN UNDER YOLO / full approval (IDEA-B1, R-CW-HOLD).
 *
 * A law file is TIGHTEN-ONLY policy. It can only ever make the mandate
 * stricter — `block` denies a write outright and `ask` force-prompts for
 * operator confirmation even when YOLO or a standing grant would otherwise
 * pass the call silently. A law file NEVER grants authority: there is no
 * "allow" action, no verb grant, and no way to lift a deny, a hard edge, or
 * any existing gate. Loading a law file can only add friction at hard edges
 * the operator explicitly declared — never remove it.
 *
 * Fail-open for holds ONLY: a missing or invalid law file means NO holds (the
 * mandate behaves exactly as before). It never means "allow something new" —
 * the underlying mandate still governs. This is the safe direction: a broken
 * law file cannot weaken a hard limit, and a missing one cannot add a prompt
 * the operator never asked for.
 *
 * File locations (project first, then home — both optional):
 *   - `<cwd>/.guru/law.json`           (project law — travels with the repo)
 *   - `<home>/.guruharness/law.json`   (home law — operator-wide holds)
 *
 * Shape (strict; unknown keys rejected):
 *   { "holds": [ { "text": "…", "paths": ["src/**", ".env"], "action": "ask" | "block" } ] }
 */

/** What a hold does when a write targets one of its paths. */
export const WriteHoldActionSchema = z.enum(["ask", "block"]);
export type WriteHoldAction = z.infer<typeof WriteHoldActionSchema>;

export const WriteHoldRuleSchema = z
  .object({
    /**
     * INVARIANT operator-facing text shown verbatim in the prompt/deny reason
     * and emitted to the audit log. Declared by the operator; the harness never
     * paraphrases it, so the reason a write was held is always legible.
     */
    text: z.string().trim().min(1),
    /**
     * Path globs (repo-relative or absolute) this hold covers. Matched against
     * the resolved absolute target of a write/edit/apply_patch call.
     */
    paths: z.array(z.string().trim().min(1)).min(1),
    action: WriteHoldActionSchema
  })
  .strict();
export type WriteHoldRule = z.infer<typeof WriteHoldRuleSchema>;

export const ProjectLawSchema = z
  .object({
    holds: z.array(WriteHoldRuleSchema).default([])
  })
  .strict();
export type ProjectLaw = z.infer<typeof ProjectLawSchema>;

export type ProjectLawStatus = "loaded" | "missing" | "invalid";

export interface ProjectLawSource {
  readonly status: ProjectLawStatus;
  readonly path: string;
  /** "project" = `<cwd>/.guru/law.json`; "home" = `<home>/.guruharness/law.json`. */
  readonly origin: "project" | "home";
  /** Rules loaded from THIS file (empty unless status === "loaded"). */
  readonly holds: readonly WriteHoldRule[];
  readonly diagnostics: readonly string[];
}

export interface ProjectLawResult {
  /**
   * The merged hold rules from every loaded law file (project + home). Empty
   * when no valid law file exists — the fail-open "no holds" case.
   */
  readonly holds: readonly WriteHoldRule[];
  readonly sources: readonly ProjectLawSource[];
}

export interface LoadProjectLawOptions {
  readonly cwd?: string;
  /** Home-profile override for tests and portable installations. */
  readonly homeDirectory?: string;
}

/** The project-law file name, kept under `.guru/` (never a third-party name). */
export const PROJECT_LAW_FILE_NAME = "law.json";

/**
 * Loads project + home write-hold law. Both files are optional; each is
 * validated independently so one broken file never masks a valid one. Rules
 * from every VALID file merge into one hold list. Any `invalid` source is
 * reported in diagnostics but contributes no holds (fail-open).
 */
export function loadProjectLaw(options: LoadProjectLawOptions = {}): ProjectLawResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeDirectory = resolveGuruHomeDirectory(options.homeDirectory);

  const candidates: readonly { path: string; origin: "project" | "home" }[] = [
    { path: join(cwd, ".guru", PROJECT_LAW_FILE_NAME), origin: "project" },
    { path: join(homeDirectory, PROJECT_LAW_FILE_NAME), origin: "home" }
  ];

  const sources = candidates.map((candidate) => loadLawFile(candidate.path, candidate.origin));
  const holds = sources.flatMap((source) => source.holds);

  return { holds, sources };
}

function loadLawFile(lawPath: string, origin: "project" | "home"): ProjectLawSource {
  if (!existsSync(lawPath)) {
    return { status: "missing", path: lawPath, origin, holds: [], diagnostics: [] };
  }
  try {
    const rawText = readFileSync(lawPath, "utf8");
    // Strip a UTF-8 BOM (Windows Notepad default) — JSON.parse throws on it,
    // which would silently drop the operator's holds. Same guard as loadConfig.
    const raw = JSON.parse(rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText) as unknown;
    const parsed = ProjectLawSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: "invalid",
        path: lawPath,
        origin,
        holds: [],
        diagnostics: parsed.error.issues.map((issue) => {
          const at = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : " at root";
          return `Invalid law${at}: ${issue.message}`;
        })
      };
    }
    return { status: "loaded", path: lawPath, origin, holds: parsed.data.holds, diagnostics: [] };
  } catch (error) {
    return {
      status: "invalid",
      path: lawPath,
      origin,
      holds: [],
      diagnostics: [`Failed to read law at ${lawPath}: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}
