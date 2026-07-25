import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import { discoverSkills } from "./loader.js";
import { SkillManifestSchema, type SkillCatalog, type SkillManifest } from "./schemas.js";

/**
 * Multi-root skill discovery with invocation gating and a progressive
 * (cache-aware) inject plan (IDEA-E1, R-CR-SKILL-ROOTS + R-PI-CTX + R-PI-PACK).
 *
 * The loader (`loader.ts`) already walks a flat list of directories; this module
 * is the DOX-level contract the rest of the harness consumes:
 *
 *   1. ROOTS — resolve the three canonical roots in precedence order
 *      (project → home → extra) so a more-specific skill shadows a general one
 *      by id instead of colliding with it.
 *   2. GATES — the SKILL.md frontmatter flags `user-invocable` and
 *      `disable-model-invocation` are honored STRUCTURALLY: a model-disabled
 *      skill is excluded from the inject plan and a non-user-invocable skill is
 *      excluded from the operator-facing pick list. Both still appear in the
 *      catalog (discovery is honest; injection is gated).
 *   3. PROGRESSIVE INJECT — build a deterministic, budgeted plan that emits
 *      manifest metadata first (name + description: cheap, always injected) and
 *      defers full bodies to an explicit load step, so the system prompt pays
 *      only for what the turn actually cites. A byte/line budget bounds the
 *      manifest section; overflow is reported, never silently dropped.
 *
 * No I/O beyond the catalog walk the loader already performs; pure shaping after
 * discovery so it stays unit-testable.
 */

/** The canonical skill roots in precedence order (most-specific first). */
export const SkillRootKindSchema = z.enum(["project", "home", "extra"]);
export type SkillRootKind = z.infer<typeof SkillRootKindSchema>;

export const SkillRootSchema = z
  .object({
    kind: SkillRootKindSchema,
    /** Absolute, normalized directory. */
    directory: z.string().trim().min(1)
  })
  .strict();
export type SkillRoot = z.infer<typeof SkillRootSchema>;

/** Frontmatter invocation flags (both default to the permissive floor). */
export const SkillInvocationSchema = z
  .object({
    /** Operator may invoke it directly (the `/skill` pick list). Default true. */
    userInvocable: z.boolean().default(true),
    /** Model may invoke it (the inject plan + tool surface). Default true. */
    modelInvocable: z.boolean().default(true)
  })
  .strict();
export type SkillInvocation = z.infer<typeof SkillInvocationSchema>;

/** A discovered skill with its root and invocation gates resolved. */
export const DiscoveredSkillSchema = z
  .object({
    manifest: SkillManifestSchema,
    root: SkillRootKindSchema,
    invocation: SkillInvocationSchema
  })
  .strict();
export type DiscoveredSkill = z.infer<typeof DiscoveredSkillSchema>;

export const SkillDiscoveryOptionsSchema = z
  .object({
    /** Project (space) skills directory. Highest precedence. */
    projectDirectory: z.string().trim().min(1).optional(),
    /** Home skills directory. Defaults to ~/.guruharness/skills. */
    homeDirectory: z.string().trim().min(1).optional(),
    /** Additional operator-configured directories, lowest precedence. */
    extraDirectories: z.array(z.string().trim().min(1)).default([]),
    /** Cwd for resolving relative extraDirectories (defaults to process.cwd()). */
    cwd: z.string().trim().min(1).optional(),
    /** Home dir override for the default home root (tests / portable installs). */
    home: z.string().trim().min(1).optional(),
    maxDepth: z.number().int().min(0).max(8).default(4)
  })
  .strict();
export type SkillDiscoveryOptions = z.infer<typeof SkillDiscoveryOptionsSchema>;

export const SkillDiscoveryResultSchema = z
  .object({
    skills: z.array(DiscoveredSkillSchema),
    roots: z.array(SkillRootSchema),
    diagnostics: z.array(z.string())
  })
  .strict();
export type SkillDiscoveryResult = z.infer<typeof SkillDiscoveryResultSchema>;

const DEFAULT_HOME_SKILLS_SUBDIR = join(".guruharness", "skills");

/**
 * Resolve the canonical roots in precedence order: project → home → extra.
 * Missing/empty segments are skipped (a bare boot has no project root; that is
 * not an error). `extra` directories are resolved against `cwd`. Pure.
 */
export function resolveSkillRoots(options: Partial<SkillDiscoveryOptions> = {}): SkillRoot[] {
  const parsed = SkillDiscoveryOptionsSchema.parse(options);
  const roots: SkillRoot[] = [];
  if (parsed.projectDirectory) {
    roots.push({ kind: "project", directory: resolve(parsed.projectDirectory) });
  }
  const homeRoot = parsed.homeDirectory ?? join(parsed.home ?? homedir(), DEFAULT_HOME_SKILLS_SUBDIR);
  roots.push({ kind: "home", directory: resolve(homeRoot) });
  const cwd = parsed.cwd ? resolve(parsed.cwd) : process.cwd();
  for (const extra of parsed.extraDirectories) {
    roots.push({ kind: "extra", directory: resolve(cwd, extra) });
  }
  // Dedup by resolved directory, keeping the highest-precedence claim.
  const seen = new Set<string>();
  return roots.filter((root) => {
    if (seen.has(root.directory)) {
      return false;
    }
    seen.add(root.directory);
    return true;
  });
}

/** Parse the invocation flags out of a manifest's frontmatter metadata. Pure. */
export function resolveSkillInvocation(manifest: SkillManifest): SkillInvocation {
  const metadata = manifest.metadata;
  const userInvocable = readFlag(metadata, "user-invocable");
  const disableModel = readFlag(metadata, "disable-model-invocation");
  return SkillInvocationSchema.parse({
    userInvocable: userInvocable ?? true,
    modelInvocable: disableModel === undefined ? true : !disableModel
  });
}

function readFlag(metadata: Record<string, unknown>, key: string): boolean | undefined {
  const value = metadata[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

/**
 * Discover across the canonical roots. The loader's first-wins dedup keeps the
 * most-specific root's skill on an id collision (roots are ordered
 * project → home → extra). Each surviving manifest is tagged with the root it
 * came from and its invocation gates.
 */
export function discoverSkillsMultiRoot(options: Partial<SkillDiscoveryOptions> = {}): SkillDiscoveryResult {
  const roots = resolveSkillRoots(options);
  const parsed = SkillDiscoveryOptionsSchema.parse(options);
  const catalog: SkillCatalog = discoverSkills({
    directories: roots.map((root) => root.directory),
    ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
    maxDepth: parsed.maxDepth
  });
  const rootByDirectory = new Map(roots.map((root) => [root.directory, root.kind]));
  const skills: DiscoveredSkill[] = [];
  for (const manifest of catalog.skills) {
    // Segment-boundary match so a root never claims a sibling directory that
    // merely shares a string prefix (e.g. /a/skills must not claim /a/skills-more).
    const rootKind =
      [...rootByDirectory.entries()].find(([directory]) => manifest.directory === directory || manifest.directory.startsWith(`${directory}${sep}`))?.[1] ??
      "extra";
    skills.push(
      DiscoveredSkillSchema.parse({
        manifest,
        root: rootKind,
        invocation: resolveSkillInvocation(manifest)
      })
    );
  }
  return SkillDiscoveryResultSchema.parse({ skills, roots, diagnostics: catalog.diagnostics });
}

/** Budget for the progressive inject plan (bytes of manifest metadata + line cap). */
export const SkillInjectBudgetSchema = z
  .object({
    maxSkills: z.number().int().positive().max(64).default(16),
    maxBytes: z.number().int().positive().max(16 * 1024).default(2048)
  })
  .strict();
export type SkillInjectBudget = z.infer<typeof SkillInjectBudgetSchema>;

export const DEFAULT_SKILL_INJECT_BUDGET: SkillInjectBudget = SkillInjectBudgetSchema.parse({});

/** One line of the cheap manifest tier: what the system prompt pays for always. */
export interface SkillInjectEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly root: SkillRootKind;
  readonly deferredBody: true;
}

export interface SkillInjectPlan {
  /** Model-invocable skills whose MANIFEST metadata is injected now. */
  readonly manifestEntries: readonly SkillInjectEntry[];
  /** Model-invocable skills whose metadata did NOT fit the budget (deferred). */
  readonly deferred: readonly string[];
  /** Skills the model may not invoke (disable-model-invocation) — excluded. */
  readonly modelDisabled: readonly string[];
  /** The rendered manifest block (already budget-bounded). */
  readonly block: string;
  readonly bytes: number;
}

/**
 * Build the progressive inject plan. Manifest metadata (id + name + description)
 * is emitted for every model-invocable skill up to the budget; full bodies are
 * NEVER injected here — they are deferred to the explicit load step
 * (`loadSkill`), which is the cache-aware part: the system prompt stays small
 * and stable, and a skill body is only paid for once the model actually cites
 * the skill. Deterministic (stable id sort) so the block is prompt-cache-friendly.
 */
export function buildSkillInjectPlan(
  skills: readonly DiscoveredSkill[],
  budget: Partial<SkillInjectBudget> = {}
): SkillInjectPlan {
  const parsedBudget = SkillInjectBudgetSchema.parse(budget);
  const sorted = [...skills].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  const modelDisabled: string[] = [];
  const candidates: DiscoveredSkill[] = [];
  for (const skill of sorted) {
    if (skill.invocation.modelInvocable) {
      candidates.push(skill);
    } else {
      modelDisabled.push(skill.manifest.id);
    }
  }
  const manifestEntries: SkillInjectEntry[] = [];
  const deferred: string[] = [];
  const lines: string[] = [];
  let bytes = 0;
  for (const skill of candidates) {
    const line = `- ${skill.manifest.id} (${skill.root}) — ${skill.manifest.description}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (manifestEntries.length >= parsedBudget.maxSkills || bytes + lineBytes > parsedBudget.maxBytes) {
      deferred.push(skill.manifest.id);
      continue;
    }
    manifestEntries.push({
      id: skill.manifest.id,
      name: skill.manifest.name,
      description: skill.manifest.description,
      root: skill.root,
      deferredBody: true
    });
    lines.push(line);
    bytes += lineBytes;
  }
  const block = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return { manifestEntries, deferred, modelDisabled, block, bytes };
}

/** The operator-facing pick list: user-invocable skills only, id-sorted. */
export function listUserInvocableSkills(skills: readonly DiscoveredSkill[]): DiscoveredSkill[] {
  return [...skills].filter((skill) => skill.invocation.userInvocable).sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}
