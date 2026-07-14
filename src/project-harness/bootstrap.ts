import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";

import { HarnessConfigSchema, type HarnessConfig } from "../config/schema.js";
import { DEFAULT_HOME_HARNESS_CONFIG, ensureGuruHome, getGuruHomePaths, type GuruHomePaths } from "../home/paths.js";
import { createFileMemoryStore } from "../memory/store.js";
import {
  ProjectHarnessManifestSchema,
  ProjectHarnessReportSchema,
  type ProjectHarnessAssetKind,
  type ProjectHarnessAssetLink,
  type ProjectHarnessManifest,
  type ProjectHarnessReport
} from "./schemas.js";

export const PROJECT_HARNESS_DIRECTORY_NAME = ".guru";
export const PROJECT_HARNESS_MANIFEST_FILE_NAME = "harness.json";
export const PROJECT_HARNESS_CONFIG_FILE_NAME = "guruharness.config.json";
export const PROJECT_SKILL_DIRECTORIES = ["./skills/local", "./skills/global"] as const;

export interface ProjectHarnessPaths {
  readonly projectRoot: string;
  readonly directory: string;
  readonly manifestPath: string;
  readonly configPath: string;
  readonly localSkillsDirectory: string;
  readonly globalSkillsLink: string;
  readonly memoryDirectory: string;
  readonly hooksDirectory: string;
  readonly promptsDirectory: string;
  readonly stateDirectory: string;
  readonly changeRecordsDirectory: string;
  readonly garageLink: string;
  readonly toolsLink: string;
}

export interface BootstrapProjectHarnessOptions {
  readonly projectRoot: string;
  readonly homeDirectory?: string;
  readonly now?: () => Date;
}

export interface RefreshProjectHarnessManifestOptions {
  readonly report: ProjectHarnessReport;
  readonly toolIds: readonly string[];
  readonly skillIds: readonly string[];
  readonly now?: () => Date;
}

/**
 * Creates one project-specific overlay without cloning reusable home assets.
 * File-backed assets are linked into the overlay; config is deliberately copied
 * once so a project can diverge from the home default without mutating it.
 */
export function bootstrapProjectHarness(options: BootstrapProjectHarnessOptions): ProjectHarnessReport {
  const paths = getProjectHarnessPaths(options.projectRoot);
  const now = options.now ?? (() => new Date());
  const diagnostics: string[] = [];
  const assetLinks: ProjectHarnessAssetLink[] = [];
  let home: GuruHomePaths | null = null;
  let seedConfig = DEFAULT_HOME_HARNESS_CONFIG;
  let configSource: "home-default" | "fallback-default" = "fallback-default";

  try {
    home = ensureGuruHome({ ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}) }).paths;
    const loaded = readHomeConfig(home.configPath);
    if (loaded) {
      seedConfig = loaded;
      configSource = "home-default";
    } else {
      diagnostics.push(`Home config at ${home.configPath} is invalid; seeded this project from the built-in portable default.`);
    }
  } catch (error) {
    diagnostics.push(`Guru home profile is unavailable: ${formatError(error)}. This project was seeded without reusable linked assets.`);
  }

  try {
    ensureProjectDirectories(paths);
    createFileMemoryStore({ directory: paths.memoryDirectory }).doctor();
  } catch (error) {
    diagnostics.push(`Project harness directory could not be initialized: ${formatError(error)}`);
    return createReport({ paths, assetLinks, diagnostics, configStatus: "existing", configSource });
  }

  const configStatus = seedProjectConfig(paths.configPath, seedConfig, diagnostics);

  if (home) {
    assetLinks.push(
      ensureDirectoryLink("skills", home.skillsDirectory, paths.globalSkillsLink),
      ensureDirectoryLink("garage", home.garageDirectory, paths.garageLink),
      ensureDirectoryLink("tools", home.toolsDirectory, paths.toolsLink)
    );
  }

  for (const assetLink of assetLinks) {
    if (assetLink.status !== "linked" && assetLink.diagnostic) {
      diagnostics.push(assetLink.diagnostic);
    }
  }

  const manifest = createOrRefreshManifest({ paths, now, configStatus, configSource, assetLinks, diagnostics });
  if (!manifest) {
    diagnostics.push(`Harness manifest could not be written at ${paths.manifestPath}; existing project files were left untouched.`);
  }

  return createReport({
    paths,
    assetLinks,
    diagnostics,
    configStatus,
    configSource,
    ...(manifest ? { manifest } : {})
  });
}

/** Update only generated catalog snapshots; it never changes user configuration or linked sources. */
export function refreshProjectHarnessManifest(options: RefreshProjectHarnessManifestOptions): ProjectHarnessReport {
  const parsedReport = ProjectHarnessReportSchema.parse(options.report);
  if (!parsedReport.manifest) {
    return parsedReport;
  }

  const now = options.now ?? (() => new Date());
  const manifest = ProjectHarnessManifestSchema.parse({
    ...parsedReport.manifest,
    updatedAt: now().toISOString(),
    toolIds: uniqueSorted(options.toolIds),
    skillIds: uniqueSorted(options.skillIds)
  });

  try {
    writeJsonAtomic(parsedReport.manifestPath, manifest);
  } catch (error) {
    const diagnostics = [...parsedReport.diagnostics, `Harness manifest catalog snapshot was not saved: ${formatError(error)}`];
    return ProjectHarnessReportSchema.parse({
      ...parsedReport,
      status: "degraded",
      diagnostics,
      summary: "Project harness is running, but its generated catalog snapshot could not be updated.",
      nextActions: ["Check write access to the project .guru directory, then restart Guru."],
      manifest: {
        ...manifest,
        diagnostics
      }
    });
  }

  return ProjectHarnessReportSchema.parse({ ...parsedReport, manifest });
}

export function getProjectHarnessPaths(projectRoot: string): ProjectHarnessPaths {
  const resolvedProjectRoot = resolve(projectRoot);
  const directory = join(resolvedProjectRoot, PROJECT_HARNESS_DIRECTORY_NAME);
  const skillsDirectory = join(directory, "skills");

  return {
    projectRoot: resolvedProjectRoot,
    directory,
    manifestPath: join(directory, PROJECT_HARNESS_MANIFEST_FILE_NAME),
    configPath: join(directory, PROJECT_HARNESS_CONFIG_FILE_NAME),
    localSkillsDirectory: join(skillsDirectory, "local"),
    globalSkillsLink: join(skillsDirectory, "global"),
    memoryDirectory: join(directory, "memory"),
    hooksDirectory: join(directory, "hooks"),
    promptsDirectory: join(directory, "agent", "prompts"),
    stateDirectory: join(directory, "state"),
    changeRecordsDirectory: join(directory, "change-records"),
    garageLink: join(directory, "garage"),
    toolsLink: join(directory, "tools")
  };
}

function ensureProjectDirectories(paths: ProjectHarnessPaths): void {
  for (const directory of [
    paths.directory,
    paths.localSkillsDirectory,
    paths.memoryDirectory,
    paths.hooksDirectory,
    paths.promptsDirectory,
    paths.stateDirectory,
    paths.changeRecordsDirectory
  ]) {
    mkdirSync(directory, { recursive: true });
  }
}

function readHomeConfig(path: string): HarnessConfig | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    const parsed = HarnessConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function seedProjectConfig(path: string, source: HarnessConfig, diagnostics: string[]): "created" | "existing" {
  try {
    lstatSync(path);
    return "existing";
  } catch (error) {
    if (!isNotFoundError(error)) {
      diagnostics.push(`Project config could not be inspected at ${path}: ${formatError(error)}`);
      return "existing";
    }
  }

  const projectConfig = HarnessConfigSchema.parse({
    ...source,
    skillDirectories: [...PROJECT_SKILL_DIRECTORIES]
  });

  try {
    writeFileSync(path, `${JSON.stringify(projectConfig, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return "existing";
    }
    diagnostics.push(`Project config could not be seeded at ${path}: ${formatError(error)}`);
    return "existing";
  }
}

function ensureDirectoryLink(kind: ProjectHarnessAssetKind, sourcePath: string, linkPath: string): ProjectHarnessAssetLink {
  const source = resolve(sourcePath);
  const link = resolve(linkPath);

  try {
    const stats = lstatSync(link);
    if (!stats.isSymbolicLink()) {
      return {
        kind,
        sourcePath: source,
        linkPath: link,
        status: "conflict",
        diagnostic: `Project ${kind} mount was not changed because ${link} is an existing non-link path.`
      };
    }

    try {
      if (samePath(realpathSync(link), source)) {
        return { kind, sourcePath: source, linkPath: link, status: "linked" };
      }
      const destination = readlinkSync(link);
      return {
        kind,
        sourcePath: source,
        linkPath: link,
        status: "conflict",
        diagnostic: `Project ${kind} mount points at ${destination}, not the active Guru home source; it was preserved.`
      };
    } catch (error) {
      return {
        kind,
        sourcePath: source,
        linkPath: link,
        status: "conflict",
        diagnostic: `Project ${kind} mount at ${link} could not be verified and was preserved: ${formatError(error)}`
      };
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      return {
        kind,
        sourcePath: source,
        linkPath: link,
        status: "unavailable",
        diagnostic: `Project ${kind} mount could not be inspected: ${formatError(error)}`
      };
    }
  }

  try {
    symlinkSync(source, link, "dir");
    return { kind, sourcePath: source, linkPath: link, status: "linked", linkType: "symbolic-link" };
  } catch (symbolicLinkError) {
    if (process.platform !== "win32") {
      return {
        kind,
        sourcePath: source,
        linkPath: link,
        status: "unavailable",
        diagnostic: `Project ${kind} symbolic link could not be created: ${formatError(symbolicLinkError)}`
      };
    }

    try {
      // A directory junction is still a live, non-copying mount and works on
      // standard Windows installs where symbolic-link privilege is unavailable.
      symlinkSync(source, link, "junction");
      return { kind, sourcePath: source, linkPath: link, status: "linked", linkType: "junction" };
    } catch (junctionError) {
      return {
        kind,
        sourcePath: source,
        linkPath: link,
        status: "unavailable",
        diagnostic: `Project ${kind} link could not be created (symbolic link: ${formatError(symbolicLinkError)}; junction: ${formatError(junctionError)}).`
      };
    }
  }
}

function createOrRefreshManifest(options: {
  readonly paths: ProjectHarnessPaths;
  readonly now: () => Date;
  readonly configStatus: "created" | "existing";
  readonly configSource: "home-default" | "fallback-default";
  readonly assetLinks: readonly ProjectHarnessAssetLink[];
  readonly diagnostics: readonly string[];
}): ProjectHarnessManifest | undefined {
  const existing = readManifest(options.paths.manifestPath);
  if (existing.status === "invalid") {
    return undefined;
  }

  const timestamp = options.now().toISOString();
  const manifest = ProjectHarnessManifestSchema.parse({
    schemaVersion: 1,
    projectRoot: options.paths.projectRoot,
    createdAt: existing.manifest?.createdAt ?? timestamp,
    updatedAt: timestamp,
    configuration: {
      path: relative(options.paths.directory, options.paths.configPath),
      status: options.configStatus,
      source: options.configSource
    },
    directories: [
      "skills/local",
      "memory",
      "hooks",
      "agent/prompts",
      "state",
      "change-records"
    ],
    assetLinks: options.assetLinks,
    toolIds: existing.manifest?.toolIds ?? [],
    skillIds: existing.manifest?.skillIds ?? [],
    diagnostics: [...options.diagnostics]
  });

  try {
    writeJsonAtomic(options.paths.manifestPath, manifest);
    return manifest;
  } catch {
    return undefined;
  }
}

function readManifest(path: string): { readonly status: "missing" | "valid" | "invalid"; readonly manifest?: ProjectHarnessManifest } {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const parsed = ProjectHarnessManifestSchema.safeParse(raw);
    return parsed.success ? { status: "valid", manifest: parsed.data } : { status: "invalid" };
  } catch (error) {
    return isNotFoundError(error) ? { status: "missing" } : { status: "invalid" };
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function createReport(options: {
  readonly paths: ProjectHarnessPaths;
  readonly assetLinks: readonly ProjectHarnessAssetLink[];
  readonly diagnostics: readonly string[];
  readonly configStatus: "created" | "existing";
  readonly configSource: "home-default" | "fallback-default";
  readonly manifest?: ProjectHarnessManifest;
}): ProjectHarnessReport {
  const status = options.diagnostics.length === 0 && options.manifest ? "ready" : "degraded";
  const summary =
    status === "ready"
      ? "Project harness is assembled from local state, linked home assets, and a writable project config."
      : "Project harness started with one or more unavailable mounts or generated files.";
  const nextActions =
    status === "ready"
      ? ["Edit .guru/guruharness.config.json to tailor this project without changing the global home default."]
      : ["Resolve the reported .guru bootstrap issue, then restart Guru to repair the project harness."];

  return ProjectHarnessReportSchema.parse({
    status,
    projectRoot: options.paths.projectRoot,
    directory: options.paths.directory,
    manifestPath: options.paths.manifestPath,
    configPath: options.paths.configPath,
    assetLinks: options.assetLinks,
    diagnostics: options.diagnostics,
    summary,
    nextActions,
    ...(options.manifest ? { manifest: options.manifest } : {})
  });
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
