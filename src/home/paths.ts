import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { HarnessConfigSchema, type HarnessConfig } from "../config/schema.js";
import { createFileMemoryStore } from "../memory/store.js";

/** The one config filename used by both the home profile and project overlays. */
export const GURU_HARNESS_CONFIG_FILE_NAME = "guruharness.config.json";
export const GURU_HOME_DIRECTORY_NAME = ".guruharness";

export interface GuruHomePaths {
  readonly root: string;
  readonly configPath: string;
  readonly skillsDirectory: string;
  readonly garageDirectory: string;
  readonly toolsDirectory: string;
  readonly memoryDirectory: string;
  readonly rolesDirectory: string;
  readonly sessionsDirectory: string;
}

export interface EnsureGuruHomeOptions {
  /** Test seam and portable-install override. Defaults to ~/.guruharness. */
  readonly homeDirectory?: string;
}

export interface EnsuredGuruHome {
  readonly paths: GuruHomePaths;
  readonly configCreated: boolean;
}

/**
 * The install/profile directory is intentionally separate from the source repo.
 * It owns reusable, operator-specific state; projects receive links or seeded
 * copies from it during their own .guru bootstrap.
 */
export function resolveGuruHomeDirectory(homeDirectory?: string): string {
  return resolve(homeDirectory ?? join(homedir(), GURU_HOME_DIRECTORY_NAME));
}

export function getGuruHomePaths(homeDirectory?: string): GuruHomePaths {
  const root = resolveGuruHomeDirectory(homeDirectory);

  return {
    root,
    configPath: join(root, GURU_HARNESS_CONFIG_FILE_NAME),
    skillsDirectory: join(root, "skills"),
    garageDirectory: join(root, "garage"),
    toolsDirectory: join(root, "tools"),
    memoryDirectory: join(root, "memory"),
    rolesDirectory: join(root, "roles"),
    sessionsDirectory: join(root, "sessions")
  };
}

/**
 * A portable profile should not assume every target is a Node repository. The
 * project bootstrap receives this as a writable seed and may tailor it.
 */
export const DEFAULT_HOME_HARNESS_CONFIG: HarnessConfig = HarnessConfigSchema.parse({
  skillDirectories: ["./skills"],
  validationCommands: []
});

/**
 * Materialize the harmless, movable pieces of a fresh installed profile. This
 * creates no credentials and never overwrites an operator's configuration.
 */
export function ensureGuruHome(options: EnsureGuruHomeOptions = {}): EnsuredGuruHome {
  const paths = getGuruHomePaths(options.homeDirectory);

  for (const directory of [
    paths.root,
    paths.skillsDirectory,
    paths.garageDirectory,
    paths.toolsDirectory,
    paths.memoryDirectory,
    paths.rolesDirectory,
    paths.sessionsDirectory
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const configCreated = writeIfAbsent(paths.configPath, `${JSON.stringify(DEFAULT_HOME_HARNESS_CONFIG, null, 2)}\n`);
  // A new Markdown vault is useful immediately and remains Obsidian-compatible.
  createFileMemoryStore({ directory: paths.memoryDirectory }).doctor();

  return { paths, configCreated };
}

function writeIfAbsent(path: string, content: string): boolean {
  if (existsSync(path)) {
    return false;
  }

  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return false;
    }
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}
