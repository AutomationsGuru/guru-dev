import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { z } from "zod";

import { readAgentsChain } from "../../repo/context.js";

export const ProjectStackHintSchema = z.object({
  name: z.string().trim().min(1),
  value: z.string().trim().min(1),
  source: z.string().trim().min(1)
});
export type ProjectStackHint = z.infer<typeof ProjectStackHintSchema>;

export const ProjectInitAgentsResultSchema = z.object({
  /** Proposed AGENTS.md markdown body (without requiring a write). */
  draft: z.string(),
  /** Detected stack hints from package.json/README. */
  hints: z.array(ProjectStackHintSchema),
  /** Whether an existing AGENTS.md already lives at the repo root. */
  hasExistingRootAgents: z.boolean(),
  /** Root-to-leaf AGENTS.md paths found under the project. */
  existingAgentsChain: z.array(z.string()),
  /** Proposed repo-relative path for the draft. */
  proposePath: z.string(),
  /** Whether the caller asked for apply; default is propose only. */
  applyRequested: z.boolean(),
  /** Human-readable summary of the proposal. */
  summary: z.string()
});
export type ProjectInitAgentsResult = z.infer<typeof ProjectInitAgentsResultSchema>;

export interface ProposeAgentsMdOptions {
  readonly repoRoot: string;
  readonly targetPath?: string;
  /** Default false; only true with explicit operator action + backup. */
  readonly apply?: boolean;
  /** Require explicit force to overwrite an existing AGENTS.md. */
  readonly force?: boolean;
}

export interface PackageJsonShape {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly type?: string;
  readonly private?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly keywords?: string[];
}

export function readRepoFile(repoRoot: string, relPath: string): string | undefined {
  const fullPath = resolve(repoRoot, relPath);
  if (!existsSync(fullPath)) return undefined;
  try {
    return readFileSync(fullPath, "utf8");
  } catch {
    return undefined;
  }
}

export function parsePackageJson(repoRoot: string): PackageJsonShape | undefined {
  const text = readRepoFile(repoRoot, "package.json");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

export function inferStackHints(repoRoot: string): ProjectStackHint[] {
  const hints: ProjectStackHint[] = [];
  const pkg = parsePackageJson(repoRoot);

  if (pkg?.name) {
    hints.push({ name: "project", value: pkg.name, source: "package.json#name" });
  }
  if (pkg?.version) {
    hints.push({ name: "version", value: pkg.version, source: "package.json#version" });
  }
  if (pkg?.description) {
    hints.push({ name: "description", value: pkg.description, source: "package.json#description" });
  }
  if (pkg?.type) {
    hints.push({ name: "module-type", value: pkg.type, source: "package.json#type" });
  }
  if (pkg?.private !== undefined) {
    hints.push({ name: "private", value: String(pkg.private), source: "package.json#private" });
  }

  const depKinds: Array<keyof PackageJsonShape> = ["dependencies", "devDependencies"];
  const depNames = new Set<string>();
  for (const kind of depKinds) {
    const deps = pkg?.[kind] as Record<string, string> | undefined;
    if (deps) {
      for (const dep of Object.keys(deps)) {
        depNames.add(dep);
      }
    }
  }

  const runtimeLibraries: Array<[string, string, string]> = [
    ["react", "React", "UI"],
    ["vue", "Vue", "UI"],
    ["svelte", "Svelte", "UI"],
    ["next", "Next.js", "UI"],
    ["express", "Express", "server"],
    ["fastify", "Fastify", "server"],
    ["nestjs", "NestJS", "server"],
    ["zod", "Zod", "validation"],
    ["typescript", "TypeScript", "language"],
    ["vitest", "Vitest", "testing"],
    ["jest", "Jest", "testing"],
    ["playwright", "Playwright", "testing"],
    ["tailwindcss", "Tailwind CSS", "styling"],
    ["postgres", "PostgreSQL", "database"],
    ["prisma", "Prisma", "database"],
    ["drizzle-orm", "Drizzle ORM", "database"]
  ];

  for (const [dep, label, category] of runtimeLibraries) {
    if (depNames.has(dep)) {
      hints.push({ name: "stack", value: `${label} (${category})`, source: `package.json#dependencies/${dep}` });
    }
  }

  const readmeText = readRepoFile(repoRoot, "README.md");
  if (readmeText) {
    const titleLine = readmeText.split(/\r?\n/u)[0]?.replace(/^#+\s*/, "").trim();
    if (titleLine) {
      hints.push({ name: "readme-title", value: titleLine, source: "README.md" });
    }
    const languageMatch = readmeText.match(/(?:^|\s)(?:TypeScript|JavaScript|Python|Go|Rust|Ruby|Java|C#)(?:\s|$)/iu);
    if (languageMatch) {
      const lang = languageMatch[0].trim();
      if (!hints.some((h) => h.name === "language" && h.value.toLowerCase() === lang.toLowerCase())) {
        hints.push({ name: "language", value: lang, source: "README.md" });
      }
    }
  }

  return hints;
}

export function buildAgentsMdDraft(options: { repoRoot: string; hints: ProjectStackHint[] }): string {
  const { repoRoot, hints } = options;
  const projectName = hints.find((h) => h.name === "project")?.value ?? "this project";
  const title = projectName === "this project" && hints.find((h) => h.name === "readme-title")?.value
    ? hints.find((h) => h.name === "readme-title")!.value
    : projectName;
  const version = hints.find((h) => h.name === "version")?.value;
  const description = hints.find((h) => h.name === "description")?.value;
  const language = hints.find((h) => h.name === "language")?.value ?? "TypeScript";
  const stackEntries = hints.filter((h) => h.name === "stack");
  const stackList = stackEntries.length > 0 ? stackEntries.map((h) => `- ${h.value}`).join("\n") : "- (stack detected from source files)";

  const now = new Date().toISOString().split("T")[0];

  return `# ${title}

**DOX contract for ${projectName}.**

_Generated ${now} by GuruHarness project_init_agents tool — review before applying, never overwrite an existing AGENTS.md without backup and explicit operator approval._

## Purpose

${description ? description : `Describe what ${title} is and why it exists.`}

## Ownership

- Matthew owns durable product behavior and release advancement.
- Agents may update this file when local contracts, surfaces, or verification change.

## Local Contracts

- Primary language: ${language}.
- Detected stack:
${stackList}
- Preferred verification: typecheck and focused tests before committing.

## Work Guidance

- Cold start: read README.md, package.json, and this AGENTS.md.
- Keep new capability at the extension/tool/skill layer; core kernel edits require explicit approval.
- Preserve existing files; prefer enhancing over replacing.
- Resolve missing capabilities as BUILD, ATTACH, or LEARN with evidence.

## Verification

- Run existing tests and typecheck when touching source files.
- Update this file when purpose, ownership, contracts, or verification change.

## Child DOX Index

- (add child AGENTS.md paths here as the project grows)
`;
}

export function proposeAgentsMd(options: ProposeAgentsMdOptions): ProjectInitAgentsResult {
  const repoRoot = resolve(options.repoRoot);
  const targetPath = resolve(options.targetPath ?? repoRoot);
  const agentsChain = readAgentsChain({ rootPath: repoRoot, targetPath });
  const existingRelativePaths = agentsChain.map((f) => relative(repoRoot, f.path).replace(/\\/gu, "/"));
  const rootAgentsPath = join(repoRoot, "AGENTS.md");
  const hasExistingRootAgents = existsSync(rootAgentsPath);

  const hints = inferStackHints(repoRoot);
  const draft = buildAgentsMdDraft({ repoRoot, hints });

  const summaryParts: string[] = [];
  if (hasExistingRootAgents) {
    summaryParts.push(`Existing AGENTS.md detected at repo root; proposal is read-only. Use explicit force + backup to overwrite.`);
  } else {
    summaryParts.push(`Draft AGENTS.md proposed for ${relative(process.cwd(), repoRoot).replace(/\\/gu, "/") || "."}.`);
  }
  summaryParts.push(`${hints.length} stack hint(s) inferred from package.json and README.`);

  return {
    draft,
    hints,
    hasExistingRootAgents,
    existingAgentsChain: existingRelativePaths,
    proposePath: "AGENTS.md",
    applyRequested: Boolean(options.apply),
    summary: summaryParts.join(" ")
  };
}
