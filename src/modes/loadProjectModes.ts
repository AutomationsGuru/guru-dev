import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

/**
 * Tool ids which represent constitutionally hard edges rather than ordinary
 * mode capabilities. A project mode may not claim one of these ids: the
 * mandate evaluator owns these edges and applies them in every mode, including
 * YOLO. Keeping them out of the mode manifest prevents a prompt posture from
 * becoming an accidental permission bypass.
 */
export const HARD_LIMIT_TOOL_IDS: readonly string[] = Object.freeze([
  "destructive",
  "spend",
  "secret-edge",
  "auth-edge"
]);

const modeToolAllowlistSchema = z.array(z.string().trim().min(1)).min(1).superRefine((toolIds, ctx) => {
  for (const toolId of toolIds) {
    if (HARD_LIMIT_TOOL_IDS.includes(toolId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `hard-limit capability cannot be added to a project mode: ${toolId}`
      });
    }
  }
});

/** A named, project-owned mode posture. */
export const ModeDefinitionSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    toolAllowlist: modeToolAllowlistSchema,
    systemAddendum: z.string().optional()
  })
  .strict();
export type ModeDefinition = z.infer<typeof ModeDefinitionSchema>;

/** The on-disk `.guru/modes.json` shape. */
export const ProjectModesFileSchema = z
  .object({
    modes: z.array(ModeDefinitionSchema)
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.modes.forEach((mode, index) => {
      if (seen.has(mode.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modes", index, "name"],
          message: `duplicate mode name: ${mode.name}`
        });
      }
      seen.add(mode.name);
    });
  });

export type ProjectModesFile = z.infer<typeof ProjectModesFileSchema>;

/** Built-in modes are always retained; project definitions may override them by name. */
export const BUILTIN_MODES: readonly ModeDefinition[] = [
  {
    name: "code",
    description: "Implementation — read, write, edit, and execute tools available",
    toolAllowlist: ["read", "write", "edit", "bash"],
    systemAddendum: "You are in CODE mode. Implement changes, write tests, verify, and iterate."
  },
  {
    name: "plan",
    description: "Planning — read-only analysis",
    toolAllowlist: ["read"],
    systemAddendum: "You are in PLAN mode. Analyze and design, but do not make changes."
  },
  {
    name: "ask",
    description: "Questions — read-only reference",
    toolAllowlist: ["read"],
    systemAddendum: "You are in ASK mode. Answer from available context without making changes."
  },
  {
    name: "review",
    description: "Review — read-only adversarial analysis",
    toolAllowlist: ["read"],
    systemAddendum: "You are in REVIEW mode. Report correctness, security, and contract findings only."
  },
  {
    name: "debug",
    description: "Debugging — diagnostics without persistent mutations",
    toolAllowlist: ["read", "bash"],
    systemAddendum: "You are in DEBUG mode. Diagnose with evidence; do not apply fixes."
  }
];

export type ProjectModesLoadStatus = "loaded" | "missing" | "invalid";
export type ProjectModesLoadVerdict = "GREEN" | "YELLOW" | "RED";
export type ProjectModesLoadSource = "file" | "config" | "defaults";

export interface ProjectModesLoadResult {
  readonly status: ProjectModesLoadStatus;
  readonly verdict: ProjectModesLoadVerdict;
  readonly source: ProjectModesLoadSource;
  readonly path: string;
  readonly modes: readonly ModeDefinition[];
  readonly diagnostics: readonly string[];
}

export interface LoadProjectModesOptions {
  readonly cwd?: string;
  /** Explicit override, useful for a caller that resolves a project overlay itself. */
  readonly filePath?: string;
  /** Optional `modes` config key; when present it takes precedence over the file. */
  readonly config?: unknown;
}

/**
 * Merge project definitions over the built-in catalog by exact name.
 *
 * The returned array is fresh and the built-ins are never mutated. Every
 * definition has already passed the hard-limit schema, so this function does
 * not create a second path around the constitutional evaluator.
 */
export function mergeProjectModes(projectModes: readonly ModeDefinition[], builtins: readonly ModeDefinition[] = BUILTIN_MODES): readonly ModeDefinition[] {
  const overrides = new Map(projectModes.map((mode) => [mode.name, mode]));
  const merged = builtins.map((mode) => overrides.get(mode.name) ?? mode);
  const builtinNames = new Set(builtins.map((mode) => mode.name));

  return [...merged, ...projectModes.filter((mode) => !builtinNames.has(mode.name))];
}

/** Validate a raw config/file value without reading or executing anything. */
export function parseProjectModes(raw: unknown): readonly ModeDefinition[] {
  return mergeProjectModes(ProjectModesFileSchema.parse(normalizeModesFile(raw)).modes);
}

/**
 * Load `.guru/modes.json` (or an explicit path), or use the caller's config
 * `modes` key. Invalid project input fails closed to builtins and reports a RED
 * result; an absent optional file reports YELLOW while keeping builtins usable.
 */
export function loadProjectModes(options: LoadProjectModesOptions = {}): ProjectModesLoadResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaultPath = join(cwd, ".guru", "modes.json");

  if (options.config !== undefined) {
    const configResult = parseModesResult(options.config, "config", defaultPath);
    if (configResult.status !== "invalid") {
      return configResult;
    }

    return configResult;
  }

  const path = resolve(options.filePath ?? defaultPath);
  if (!existsSync(path)) {
    return {
      status: "missing",
      verdict: "YELLOW",
      source: "defaults",
      path,
      modes: BUILTIN_MODES,
      diagnostics: [`Project modes file not found at ${path}; using built-in modes.`]
    };
  }

  try {
    const text = readFileSync(path, "utf8");
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    return parseModesResult(raw, "file", path);
  } catch (error) {
    return {
      status: "invalid",
      verdict: "RED",
      source: "file",
      path,
      modes: BUILTIN_MODES,
      diagnostics: [`Invalid project modes at ${path}: ${formatError(error)}`]
    };
  }
}

function normalizeModesFile(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return { modes: raw };
  }
  if (typeof raw === "object" && raw !== null && "modes" in raw) {
    return raw;
  }
  return raw;
}

function parseModesResult(raw: unknown, source: "file" | "config", path: string): ProjectModesLoadResult {
  const parsed = ProjectModesFileSchema.safeParse(normalizeModesFile(raw));
  if (!parsed.success) {
    return {
      status: "invalid",
      verdict: "RED",
      source,
      path,
      modes: BUILTIN_MODES,
      diagnostics: parsed.error.issues.map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `Invalid project modes at ${issuePath}: ${issue.message}`;
      })
    };
  }

  return {
    status: "loaded",
    verdict: "GREEN",
    source,
    path,
    modes: mergeProjectModes(parsed.data.modes),
    diagnostics: []
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "could not parse JSON";
}
