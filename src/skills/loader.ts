import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  SkillCatalogSchema,
  SkillDocumentSchema,
  SkillLoaderOptionsSchema,
  SkillManifestSchema,
  type SkillCatalog,
  type SkillDocument,
  type SkillLoaderOptions,
  type SkillManifest
} from "./schemas.js";

interface ParsedSkillFile {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

const DEFAULT_DESCRIPTION = "File-based GuruHarness skill.";
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

export function discoverSkills(options: Partial<SkillLoaderOptions> = {}): SkillCatalog {
  const parsedOptions = SkillLoaderOptionsSchema.parse(options);
  const cwd = parsedOptions.cwd ? resolve(parsedOptions.cwd) : process.cwd();
  const roots = resolveSkillDirectories(parsedOptions.directories, cwd);
  const diagnostics: string[] = [];
  const manifests: SkillManifest[] = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      diagnostics.push(`Skill directory not found: ${root}`);
      continue;
    }

    if (!statSync(root).isDirectory()) {
      diagnostics.push(`Skill path is not a directory: ${root}`);
      continue;
    }

    manifests.push(...discoverSkillsInDirectory(root, parsedOptions.skillFileName, parsedOptions.maxDepth, diagnostics));
  }

  // First-wins dedup (review 2026-07-08): the old code THREW on any duplicate id,
  // wiping the ENTIRE catalog for one collision (a bridge skill borrowed from two
  // harnesses, or a user+project name clash) — every good skill disappeared. Roots
  // are ordered project→user→role, so first-wins keeps the most-specific root's
  // skill and drops later collisions with a diagnostic instead of nuking the load.
  const seenIds = new Set<string>();
  const deduped: SkillManifest[] = [];
  for (const manifest of manifests) {
    if (seenIds.has(manifest.id)) {
      diagnostics.push(`Duplicate skill id '${manifest.id}' — kept the first (from an earlier root), dropped this one (${manifest.skillFile}).`);
      continue;
    }
    seenIds.add(manifest.id);
    deduped.push(manifest);
  }

  return SkillCatalogSchema.parse({
    skills: deduped.sort((a, b) => a.id.localeCompare(b.id)),
    directories: roots,
    diagnostics
  });
}

export function loadSkill(options: Partial<SkillLoaderOptions> & { skillId: string }): SkillDocument {
  const { skillId, ...loaderOptions } = options;
  const catalog = discoverSkills(loaderOptions);
  const manifest = catalog.skills.find((candidate) => candidate.id === skillId);

  if (!manifest) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  const content = readFileSync(manifest.skillFile, "utf8");
  const parsedFile = parseSkillFile(content);

  return SkillDocumentSchema.parse({
    manifest,
    content,
    body: parsedFile.body,
    frontmatter: parsedFile.frontmatter
  });
}

export function resolveSkillReferencePath(
  options: Partial<SkillLoaderOptions> & { skillId: string; reference: string }
): string {
  const { reference, ...loadOptions } = options;
  const skill = loadSkill(loadOptions);
  const resolvedPath = resolve(skill.manifest.directory, reference);

  if (!isPathInside(resolvedPath, skill.manifest.directory)) {
    throw new Error(`Skill reference escapes skill directory: ${reference}`);
  }

  return resolvedPath;
}

function resolveSkillDirectories(directories: readonly string[], cwd: string): string[] {
  return [
    ...new Set(
      directories.map((directory) => {
        const expandedDirectory = expandHomeDirectory(directory);

        return isAbsolute(expandedDirectory) ? resolve(expandedDirectory) : resolve(cwd, expandedDirectory);
      })
    )
  ];
}

function expandHomeDirectory(directory: string): string {
  if (directory === "~") {
    return homedir();
  }

  if (directory.startsWith("~/") || directory.startsWith("~\\")) {
    return join(homedir(), directory.slice(2));
  }

  return directory;
}

function discoverSkillsInDirectory(
  directory: string,
  skillFileName: string,
  maxDepth: number,
  diagnostics: string[]
): SkillManifest[] {
  const manifests: SkillManifest[] = [];
  const skillFile = join(directory, skillFileName);

  if (existsSync(skillFile) && statSync(skillFile).isFile()) {
    try {
      manifests.push(readSkillManifest(directory, skillFile));
    } catch (error) {
      diagnostics.push(`${skillFile}: ${formatError(error)}`);
    }
  }

  if (maxDepth === 0) {
    return manifests;
  }

  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    manifests.push(...discoverSkillsInDirectory(join(directory, entry.name), skillFileName, maxDepth - 1, diagnostics));
  }

  return manifests;
}

function readSkillManifest(directory: string, skillFile: string): SkillManifest {
  const content = readFileSync(skillFile, "utf8");
  const parsedFile = parseSkillFile(content);
  const id = readStringAttribute(parsedFile.frontmatter, "name") ?? basename(directory);
  const title = readMarkdownTitle(parsedFile.body) ?? id;
  const description = readStringAttribute(parsedFile.frontmatter, "description") ?? readFirstParagraph(parsedFile.body) ?? DEFAULT_DESCRIPTION;
  const allowedTools = readStringListAttribute(parsedFile.frontmatter, "allowed-tools");
  const metadata = { ...parsedFile.frontmatter };
  // Bridge loading (§14/§16): `type: bridge` marks an ATTACH-class skill borrowed
  // from another harness; `bridges:` names what it wraps (e.g. pi).
  const kind = readStringAttribute(parsedFile.frontmatter, "type") === "bridge" ? "bridge" : "native";
  const bridges = readStringAttribute(parsedFile.frontmatter, "bridges");

  return SkillManifestSchema.parse({
    id,
    name: title,
    description,
    directory,
    skillFile,
    allowedTools,
    kind,
    ...(bridges ? { bridges } : {}),
    metadata
  });
}

function parseSkillFile(content: string): ParsedSkillFile {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content.trim() };
  }

  const lines = content.split(/\r?\n/);
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (closingIndex < 0) {
    return { frontmatter: {}, body: content.trim() };
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const body = lines.slice(closingIndex + 1).join("\n").trim();

  return {
    frontmatter: parseSimpleYamlFrontmatter(frontmatterLines),
    body
  };
}

function parseSimpleYamlFrontmatter(lines: readonly string[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const delimiterIndex = trimmed.indexOf(":");
    if (delimiterIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, delimiterIndex).trim();
    const value = trimmed.slice(delimiterIndex + 1).trim();
    attributes[key] = parseFrontmatterValue(key, value);
  }

  return attributes;
}

function parseFrontmatterValue(key: string, value: string): string | string[] {
  const unquoted = stripQuotes(value);

  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    return splitCommaSeparatedList(unquoted.slice(1, -1));
  }

  if (key === "allowed-tools") {
    return splitCommaSeparatedList(unquoted);
  }

  return unquoted;
}

function splitCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  return value.replace(/^['\"]|['\"]$/g, "");
}

function readStringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];

  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringListAttribute(attributes: Record<string, unknown>, key: string): string[] {
  const value = attributes[key];

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }

  return [];
}

function readMarkdownTitle(body: string): string | undefined {
  const titleLine = body.split(/\r?\n/).find((line) => line.startsWith("# "));

  return titleLine?.replace(/^#\s+/, "").trim();
}

function readFirstParagraph(body: string): string | undefined {
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .find((block) => block.length > 0 && !block.startsWith("#"));

  return paragraph;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPathInside(childPath: string, parentPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath));

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
