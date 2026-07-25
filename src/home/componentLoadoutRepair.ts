import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { z } from "zod";

import { getGuruHomePaths, type GuruHomePaths } from "./paths.js";

// ── Install-state schema ────────────────────────────────────────────────

/**
 * A single recorded component: its unique id, when it was recorded, and the
 * relative paths it claims inside the home profile. Paths are relative to the
 * home root so the record is portable across install locations.
 */
export const ComponentRecordSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    installedAt: z.string().trim().min(1),
    paths: z.array(z.string().trim().min(1).max(1024)).default([])
  })
  .strict();
export type ComponentRecord = z.infer<typeof ComponentRecordSchema>;

export const InstallStateSchema = z
  .object({
    version: z.number().int().positive().default(1),
    generatedAt: z.string().trim().min(1),
    components: z.array(ComponentRecordSchema).default([])
  })
  .strict();
export type InstallState = z.infer<typeof InstallStateSchema>;

/** The filename inside the home root that holds the install-state record. */
export const INSTALL_STATE_FILE_NAME = "install-state.json";

// ── Doctor report ────────────────────────────────────────────────────────

export interface DoctorReport {
  /** How many component ids are recorded. */
  readonly recorded: number;
  /** Component ids whose claimed paths all exist on disk. */
  readonly present: string[];
  /** Component ids where at least one claimed path (or the component itself) is missing from disk. */
  readonly missing: string[];
  /**
   * Paths that exist on disk inside the home profile but are not claimed by
   * any recorded component. Paths are relative to the home root.
   */
  readonly extra: string[];
  /** True when nothing is missing and nothing is extra. */
  readonly healthy: boolean;
}

// ── Repair report ────────────────────────────────────────────────────────

export interface RepairReport {
  /** Component ids that were missing and could not be restored (file data is lost). */
  readonly stillMissing: string[];
  /** Extra paths that were removed. */
  readonly removed: string[];
  /** True when the run was a dry-run — nothing was actually deleted. */
  readonly dryRun: boolean;
}

// ── Uninstall list ───────────────────────────────────────────────────────

export interface UninstallList {
  /** The component ids that would be uninstalled. */
  readonly ids: string[];
  /** Every path that would be removed (relative to home root). */
  readonly paths: string[];
  /** Count of paths. */
  readonly pathCount: number;
}

// ── File-system test seam ───────────────────────────────────────────────

export interface ComponentRepairFS {
  readonly exists: (absolutePath: string) => boolean;
  readonly isDirectory: (absolutePath: string) => boolean;
  readonly readDir: (absolutePath: string) => string[];
  readonly readFile: (absolutePath: string) => string;
  readonly writeFile: (absolutePath: string, content: string) => void;
  readonly mkdir: (absolutePath: string) => void;
  readonly unlink: (absolutePath: string) => void;
  readonly rmdir: (absolutePath: string) => void;
}

const realFS: ComponentRepairFS = {
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  readDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  unlink: (path) => unlinkSync(path),
  rmdir: (path) => rmdirSync(path)
};

// ── Options ──────────────────────────────────────────────────────────────

export interface DoctorOptions {
  /** Home directory override (defaults to ~/.guruharness). */
  readonly homeDirectory?: string;
  /** File-system seam for testing. */
  readonly fs?: ComponentRepairFS;
}

export interface RepairOptions {
  readonly homeDirectory?: string;
  readonly fs?: ComponentRepairFS;
}

export interface UninstallOptions {
  readonly homeDirectory?: string;
  readonly fs?: ComponentRepairFS;
}

// ── Internal helpers ─────────────────────────────────────────────────────

function resolveHome(options: { homeDirectory?: string }): GuruHomePaths {
  return getGuruHomePaths(options.homeDirectory);
}

function installStatePath(paths: GuruHomePaths): string {
  return join(paths.root, INSTALL_STATE_FILE_NAME);
}

function readInstallState(fs: ComponentRepairFS, homePaths: GuruHomePaths): InstallState | undefined {
  const path = installStatePath(homePaths);
  if (!fs.exists(path)) return undefined;
  try {
    const raw = JSON.parse(fs.readFile(path)) as unknown;
    return InstallStateSchema.parse(raw);
  } catch {
    return undefined;
  }
}

function writeInstallState(fs: ComponentRepairFS, homePaths: GuruHomePaths, state: InstallState): void {
  fs.mkdir(homePaths.root);
  fs.writeFile(installStatePath(homePaths), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Collect every relative path claimed by the recorded components.
 * Returns a Set keyed by relative-to-home-root paths.
 */
function claimedPathSet(components: readonly ComponentRecord[]): Set<string> {
  const claimed = new Set<string>();
  for (const component of components) {
    for (const path of component.paths) {
      claimed.add(path);
    }
  }
  return claimed;
}

/**
 * Walk the home root directory and return every relative path that looks like
 * a managed file (not a directory, not the install-state file itself, not a
 * hidden dot-directory). Symlinks are treated as opaque entries.
 */
function walkManagedFiles(fs: ComponentRepairFS, homePaths: GuruHomePaths): string[] {
  const files: string[] = [];
  const stateFileName = INSTALL_STATE_FILE_NAME;

  function walk(dir: string, base: string): void {
    for (const name of fs.readDir(dir)) {
      if (name === stateFileName && base === "") continue; // skip the install-state file itself
      const absolutePath = join(dir, name);
      const relativePath = base ? `${base}/${name}` : name;
      if (fs.isDirectory(absolutePath)) {
        walk(absolutePath, relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walk(homePaths.root, "");
  return files;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Record (or update) a component's id and claimed paths in the install-state.
 * If the id already exists its entry is replaced; otherwise it is appended.
 * This is the write side — call it when a component is installed.
 */
export function recordComponent(
  id: string,
  paths: string[],
  options: DoctorOptions = {}
): InstallState {
  const fs = options.fs ?? realFS;
  const homePaths = resolveHome(options);
  const now = new Date().toISOString();

  const existing = readInstallState(fs, homePaths);
  const components = existing?.components ?? [];
  const others = components.filter((component) => component.id !== id);

  const record: ComponentRecord = ComponentRecordSchema.parse({ id, paths, installedAt: now });
  const state: InstallState = {
    version: existing?.version ?? 1,
    generatedAt: now,
    components: [...others, record].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  };

  writeInstallState(fs, homePaths, state);
  return state;
}

/**
 * Unrecord a component id from the install-state. The files themselves are
 * **not** removed — this only drops the record entry so doctor stops tracking
 * the component. Use {@link dryRunUninstall} first if you want to see what
 * paths would be affected.
 */
export function unrecordComponent(id: string, options: DoctorOptions = {}): InstallState | undefined {
  const fs = options.fs ?? realFS;
  const homePaths = resolveHome(options);

  const existing = readInstallState(fs, homePaths);
  if (!existing || !existing.components.some((c) => c.id === id)) return undefined;

  const now = new Date().toISOString();
  const state: InstallState = {
    ...existing,
    generatedAt: now,
    components: existing.components.filter((c) => c.id !== id)
  };

  writeInstallState(fs, homePaths, state);
  return state;
}

/**
 * Doctor: compare the recorded install-state against the filesystem.
 *
 * - `present`: ids whose every claimed path exists on disk.
 * - `missing`: ids with at least one claimed path absent.
 * - `extra`: files on disk not claimed by any recorded component.
 */
export function doctor(options: DoctorOptions = {}): DoctorReport {
  const fs = options.fs ?? realFS;
  const homePaths = resolveHome(options);

  const state = readInstallState(fs, homePaths);
  const recorded = state?.components ?? [];
  const claimed = claimedPathSet(recorded);
  const diskFiles = new Set(walkManagedFiles(fs, homePaths));

  const present: string[] = [];
  const missing: string[] = [];

  for (const component of recorded) {
    const allPresent = component.paths.length === 0 || component.paths.every((path) => diskFiles.has(path));
    (allPresent ? present : missing).push(component.id);
  }

  const extra: string[] = [];
  for (const file of diskFiles) {
    if (!claimed.has(file)) {
      extra.push(file);
    }
  }
  extra.sort();

  return {
    recorded: recorded.length,
    present,
    missing,
    extra,
    healthy: missing.length === 0 && extra.length === 0
  };
}

/**
 * Repair: remove every extra file that is not claimed by any recorded
 * component. Missing files are reported but cannot be restored (the data is
 * lost — the record only stores metadata, not file contents).
 *
 * Pass `dryRun: true` to get the report without actually removing anything.
 */
export function repair(options: RepairOptions & { readonly dryRun?: boolean } = {}): RepairReport {
  const fs = options.fs ?? realFS;
  const homePaths = resolveHome(options);
  const dryRun = options.dryRun === true;

  const report = doctor(
    options.homeDirectory !== undefined ? { homeDirectory: options.homeDirectory, fs } : { fs }
  );

  const removed: string[] = [];

  for (const relativePath of report.extra) {
    const absolutePath = join(homePaths.root, relativePath);
    if (!dryRun) {
      try {
        fs.unlink(absolutePath);
      } catch {
        // If unlink fails (e.g. it's a directory), try rmdir and skip on failure.
        try {
          fs.rmdir(absolutePath);
        } catch {
          continue;
        }
      }
    }
    removed.push(relativePath);
  }

  // Clean up empty directories left behind after extra-file removal.
  if (!dryRun) {
    removeEmptyDirectories(fs, homePaths.root);
  }

  return {
    stillMissing: report.missing,
    removed,
    dryRun
  };
}

function removeEmptyDirectories(fs: ComponentRepairFS, dir: string): void {
  for (const name of fs.readDir(dir)) {
    const child = join(dir, name);
    if (fs.isDirectory(child)) {
      removeEmptyDirectories(fs, child);
      try {
        if (fs.readDir(child).length === 0) {
          fs.rmdir(child);
        }
      } catch {
        // Non-empty or already gone — fine.
      }
    }
  }
}

/**
 * Dry-run uninstall: return every path that would be removed if the given
 * component ids were uninstalled (both from the record and from disk).
 * Does not mutate anything.
 */
export function dryRunUninstall(ids: string[], options: UninstallOptions = {}): UninstallList {
  const fs = options.fs ?? realFS;
  const homePaths = resolveHome(options);

  const state = readInstallState(fs, homePaths);
  const idSet = new Set(ids);

  const paths: string[] = [];
  const matched: string[] = [];

  for (const component of state?.components ?? []) {
    if (idSet.has(component.id)) {
      matched.push(component.id);
      for (const path of component.paths) {
        if (fs.exists(join(homePaths.root, path))) {
          paths.push(path);
        }
      }
    }
  }

  const uniquePaths = [...new Set(paths)].sort();

  return {
    ids: matched.sort(),
    paths: uniquePaths,
    pathCount: uniquePaths.length
  };
}

/**
 * Read the current install state (may be undefined if it does not exist or is
 * unparseable). This is a read-only view — use {@link recordComponent} or
 * {@link unrecordComponent} to mutate.
 */
export function readInstallStateSnapshot(options: DoctorOptions = {}): InstallState | undefined {
  const fs = options.fs ?? realFS;
  const homePaths = resolveHome(options);
  return readInstallState(fs, homePaths);
}

/**
 * Rebuild (re-seed) the install-state from the current filesystem. This is a
 * recovery path: if the install-state file is lost, scan the home directory
 * and create a new record where every top-level directory becomes a component
 * entry with the files inside it claimed as its paths.
 *
 * Warning: this is a best-effort heuristic and may produce different ids than
 * the original install-state. Prefer repair over rebuild unless the
 * install-state file itself is corrupted or missing.
 */
export function rebuildInstallState(options: DoctorOptions = {}): InstallState {
  const fs = options.fs ?? realFS;
  const homePaths = resolveHome(options);
  const now = new Date().toISOString();

  const components: ComponentRecord[] = [];
  for (const name of fs.readDir(homePaths.root)) {
    if (name === INSTALL_STATE_FILE_NAME) continue;
    const absolutePath = join(homePaths.root, name);
    if (!fs.isDirectory(absolutePath)) continue;

    const paths: string[] = [];
    collectFiles(fs, absolutePath, name, paths);
    components.push({ id: name, installedAt: now, paths: paths.sort() });
  }

  components.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const state: InstallState = { version: 1, generatedAt: now, components };
  writeInstallState(fs, homePaths, state);
  return state;
}

function collectFiles(fs: ComponentRepairFS, dir: string, prefix: string, out: string[]): void {
  for (const name of fs.readDir(dir)) {
    const child = join(dir, name);
    const relativeChild = `${prefix}/${name}`;
    if (fs.isDirectory(child)) {
      collectFiles(fs, child, relativeChild, out);
    } else {
      out.push(relativeChild);
    }
  }
}
