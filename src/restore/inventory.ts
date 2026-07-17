import { closeSync, lstatSync, opendirSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { HarnessConfigSchema, type HarnessConfig } from "../config/schema.js";
import { createDirectProviderCatalog } from "../providers/catalog.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import { containsSecretValue } from "../safety/secretSafety.js";
import type { ConfigSummary, InventoryEntry, InventoryEntryKind } from "./manifests.js";

export type RestoreInventoryRoot = "guru-home" | "project";

export interface RestoreInventoryLimits {
  readonly maxDepth: number;
  readonly maxFileCount: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
}

export interface RestoreInventoryAsset {
  readonly id: string;
  readonly root: RestoreInventoryRoot;
  /** Logical POSIX path. The writer reconstructs the source from its explicit roots. */
  readonly path: string;
  readonly packagePath: string;
  readonly bytes: number;
}

export interface RestoreInventoryLink {
  readonly id: string;
  readonly root: RestoreInventoryRoot;
  readonly path: string;
  readonly target: string;
}

export interface RestoreInventory {
  readonly components: readonly InventoryEntry[];
  readonly configSummary: ConfigSummary;
  readonly connections: readonly InventoryEntry[];
  readonly skillsIndex: readonly InventoryEntry[];
  readonly toolsIndex: readonly InventoryEntry[];
  readonly assets: readonly RestoreInventoryAsset[];
  readonly links: readonly RestoreInventoryLink[];
  readonly limits: RestoreInventoryLimits;
}

export interface CreateRestoreInventoryOptions {
  readonly guruHomeDirectory: string;
  readonly projectRoot?: string;
  readonly providerRoutes?: readonly ProviderRouteDescriptor[];
  readonly limits?: Partial<RestoreInventoryLimits>;
}

type InventoryBucket = "components" | "skillsIndex" | "toolsIndex";

interface PortablePathSpec {
  readonly root: RestoreInventoryRoot;
  readonly absolutePath: string;
  readonly logicalPath: string;
  readonly bucket: InventoryBucket;
  readonly kind: InventoryEntryKind;
  readonly parseConfig?: boolean;
}

interface RootIdentity {
  readonly absolutePath: string;
  readonly realPath: string;
}

interface ScanState {
  readonly limits: RestoreInventoryLimits;
  readonly roots: Readonly<Record<RestoreInventoryRoot, RootIdentity | undefined>>;
  readonly components: InventoryEntry[];
  readonly skillsIndex: InventoryEntry[];
  readonly toolsIndex: InventoryEntry[];
  readonly assets: RestoreInventoryAsset[];
  readonly links: RestoreInventoryLink[];
  readonly envNames: Set<string>;
  readonly sourcePaths: Set<string>;
  readonly connections: Map<string, InventoryEntry>;
  fileCount: number;
  totalBytes: number;
  visitedEntries: number;
  stopped: boolean;
}

const DEFAULT_LIMITS: RestoreInventoryLimits = {
  maxDepth: 8,
  maxFileCount: 1_000,
  maxTotalBytes: 10 * 1024 * 1024,
  maxFileBytes: 256 * 1024
};

const HARD_LIMITS: RestoreInventoryLimits = {
  maxDepth: 16,
  maxFileCount: 5_000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024
};

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const MAX_ENV_NAME_LENGTH = 256;
const MAX_LOGICAL_PATH_LENGTH = 1_024;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u;
const RISKY_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "credentials",
  "credential",
  "auth",
  "vault",
  "secrets",
  "secret",
  "memory",
  "sessions",
  "session",
  "cache",
  "caches",
  ".cache",
  "logs",
  "log",
  "runtime",
  "state",
  "tmp",
  "temp",
  ".trash",
  ".ssh",
  ".aws"
]);
const RISKY_FILE_SUFFIXES = [".key", ".pem", ".p12", ".pfx", ".crt", ".der", ".kdbx"];
const TEMP_FILE_SUFFIXES = [".tmp", ".temp", ".swp", ".swo", "~"];

/** Build the bounded logical inventory consumed by the restore-package writer. */
export function createRestoreInventory(options: CreateRestoreInventoryOptions): RestoreInventory {
  const guruHome = resolve(options.guruHomeDirectory);
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : undefined;
  const limits = normalizeLimits(options.limits);
  const state: ScanState = {
    limits,
    roots: {
      "guru-home": createRootIdentity(guruHome),
      project: projectRoot ? createRootIdentity(projectRoot) : undefined
    },
    components: [],
    skillsIndex: [],
    toolsIndex: [],
    assets: [],
    links: [],
    envNames: new Set<string>(),
    sourcePaths: new Set<string>(),
    connections: new Map<string, InventoryEntry>(),
    fileCount: 0,
    totalBytes: 0,
    visitedEntries: 0,
    stopped: false
  };

  inventoryProviders(options.providerRoutes ?? createDirectProviderCatalog(), state);

  const homeSpecs: readonly PortablePathSpec[] = [
    fileSpec("guru-home", join(guruHome, "guruharness.config.json"), "guru-home/guruharness.config.json", "components", "config", true),
    directorySpec("guru-home", join(guruHome, "skills"), "guru-home/skills", "skillsIndex", "skill"),
    directorySpec("guru-home", join(guruHome, "garage"), "guru-home/garage", "components", "doc"),
    directorySpec("guru-home", join(guruHome, "tools"), "guru-home/tools", "toolsIndex", "tool"),
    directorySpec("guru-home", join(guruHome, "roles"), "guru-home/roles", "components", "prompt")
  ];
  inventorySpecs(homeSpecs, state);

  if (projectRoot && !state.stopped) {
    const projectHarness = join(projectRoot, ".guru");
    const projectSpecs: readonly PortablePathSpec[] = [
      fileSpec("project", join(projectHarness, "guruharness.config.json"), "project/.guru/guruharness.config.json", "components", "config", true),
      fileSpec("project", join(projectHarness, "harness.json"), "project/.guru/harness.json", "components", "config"),
      directorySpec("project", join(projectHarness, "skills", "local"), "project/.guru/skills/local", "skillsIndex", "skill"),
      directorySpec("project", join(projectHarness, "hooks"), "project/.guru/hooks", "components", "script"),
      directorySpec("project", join(projectHarness, "agent", "prompts"), "project/.guru/agent/prompts", "components", "prompt")
    ];
    inventorySpecs(projectSpecs, state);

    for (const [relativePath, bucket, kind] of [
      ["skills/global", "skillsIndex", "skill"],
      ["garage", "components", "doc"],
      ["tools", "toolsIndex", "tool"]
    ] as const) {
      if (state.stopped) break;
      inspectExplicitLink(
        {
          root: "project",
          absolutePath: join(projectHarness, relativePath),
          logicalPath: `project/.guru/${toPosix(relativePath)}`,
          bucket,
          kind
        },
        state
      );
    }
  }

  return {
    components: uniqueSortedEntries(state.components),
    configSummary: {
      envNames: [...state.envNames].sort(compareText),
      sourcePaths: [...state.sourcePaths].sort(compareText)
    },
    connections: uniqueSortedEntries([...state.connections.values()]),
    skillsIndex: uniqueSortedEntries(state.skillsIndex),
    toolsIndex: uniqueSortedEntries(state.toolsIndex),
    assets: uniqueById(state.assets).sort((left, right) => compareText(left.path, right.path)),
    links: uniqueById(state.links).sort((left, right) => compareText(left.path, right.path)),
    limits
  };
}

function inventorySpecs(specs: readonly PortablePathSpec[], state: ScanState): void {
  for (const spec of specs) {
    if (state.stopped) return;
    let stats: Stats;
    try {
      stats = lstatSync(spec.absolutePath);
    } catch {
      if (spec.parseConfig || spec.logicalPath.endsWith("/harness.json")) {
        recordEntry(state, spec.bucket, entry(`missing:${spec.logicalPath}`, spec.kind, spec.logicalPath, "missing", "not-found"));
      }
      continue;
    }

    if (stats.isDirectory()) {
      walkPortableDirectory(spec, spec.absolutePath, spec.logicalPath, 0, state);
    } else {
      inspectPath(spec, stats, spec.logicalPath, state);
    }
  }
}

function walkPortableDirectory(spec: PortablePathSpec, absoluteDirectory: string, logicalDirectory: string, depth: number, state: ScanState): void {
  if (state.stopped) return;
  const names: string[] = [];
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(absoluteDirectory);
    while (true) {
      const dirent = directory.readSync();
      if (!dirent) break;
      state.visitedEntries += 1;
      if (state.visitedEntries > maxWalkEntries(state.limits)) {
        addLimitEntry(state, "walk-entries", logicalDirectory);
        state.stopped = true;
        break;
      }
      names.push(dirent.name);
    }
  } catch {
    recordEntry(state, spec.bucket, entry(`excluded:${logicalDirectory}`, spec.kind, logicalDirectory, "excluded", "unreadable-directory"));
    return;
  } finally {
    try {
      directory?.closeSync();
    } catch {
      // Inventory is read-only; a close failure cannot justify exposing the host error/path.
    }
  }

  names.sort(compareText);
  for (const name of names) {
    if (state.stopped) return;
    const absolutePath = join(absoluteDirectory, name);
    const logicalPath = `${logicalDirectory}/${toPosix(name)}`;
    if (logicalPath.length > MAX_LOGICAL_PATH_LENGTH) {
      addPathLengthEntry(state, spec.logicalPath);
      continue;
    }
    let stats: Stats;
    try {
      stats = lstatSync(absolutePath);
    } catch {
      recordEntry(state, spec.bucket, entry(`excluded:${logicalPath}`, spec.kind, logicalPath, "excluded", "unreadable"));
      continue;
    }

    if (stats.isDirectory()) {
      if (depth >= state.limits.maxDepth) {
        recordEntry(state, spec.bucket, entry(`limit:depth:${logicalPath}`, spec.kind, logicalPath, "excluded", "depth-cap"));
      } else {
        walkPortableDirectory(spec, absolutePath, logicalPath, depth + 1, state);
      }
      continue;
    }
    inspectPath({ ...spec, absolutePath, logicalPath }, stats, spec.logicalPath, state);
  }
}

function inspectExplicitLink(spec: PortablePathSpec, state: ScanState): void {
  let stats: Stats;
  try {
    stats = lstatSync(spec.absolutePath);
  } catch {
    return;
  }
  if (!stats.isSymbolicLink()) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "expected-link"));
    return;
  }
  inspectPath(spec, stats, spec.logicalPath, state);
}

function inspectPath(spec: PortablePathSpec, stats: Stats, capPath: string, state: ScanState): void {
  if (spec.logicalPath.length > MAX_LOGICAL_PATH_LENGTH) {
    addPathLengthEntry(state, capPath);
    return;
  }
  if (stats.isSymbolicLink()) {
    if (!reserveFileSlot(state, capPath)) return;
    inspectLink(spec, state);
    return;
  }
  if (!stats.isFile()) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "unsupported-file-type"));
    return;
  }
  if (!reserveFileSlot(state, capPath)) return;
  inventoryRegularFile(spec, stats.size, state);
}

function inventoryRegularFile(spec: PortablePathSpec, size: number, state: ScanState): void {
  if (isRiskyLogicalPath(spec.logicalPath)) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "unsafe-path"));
    return;
  }
  if (size > state.limits.maxFileBytes) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "file-byte-cap"));
    return;
  }
  if (state.totalBytes + size > state.limits.maxTotalBytes) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "total-byte-cap"));
    return;
  }

  const boundedRead = readBoundedFile(spec.absolutePath, state.limits.maxFileBytes);
  if (boundedRead.status === "unreadable") {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "unreadable"));
    return;
  }
  if (boundedRead.status === "oversized") {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "file-byte-cap"));
    return;
  }
  const content = boundedRead.content;
  if (state.totalBytes + content.byteLength > state.limits.maxTotalBytes) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "total-byte-cap"));
    return;
  }
  if (isBinary(content)) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "binary-file"));
    return;
  }

  state.totalBytes += content.byteLength;
  const assetId = `asset:${spec.logicalPath}`;
  state.assets.push({
    id: assetId,
    root: spec.root,
    path: spec.logicalPath,
    packagePath: `assets/${spec.logicalPath}`,
    bytes: content.byteLength
  });
  recordEntry(state, spec.bucket, entry(assetId, spec.kind, spec.logicalPath, "present"));

  if (spec.parseConfig) {
    inventoryConfig(content, spec.logicalPath, state);
  }
}

function inspectLink(spec: PortablePathSpec, state: ScanState): void {
  if (isRiskyLogicalPath(spec.logicalPath)) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "unsafe-path"));
    return;
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(spec.absolutePath);
  } catch {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "unresolved-link"));
    return;
  }

  const target = logicalTargetFor(realTarget, spec.root, state.roots);
  if (!target) {
    recordEntry(state, spec.bucket, entry(`excluded:${spec.logicalPath}`, spec.kind, spec.logicalPath, "excluded", "symlink-escape"));
    return;
  }
  const linkId = `link:${spec.logicalPath}`;
  state.links.push({ id: linkId, root: spec.root, path: spec.logicalPath, target });
  recordEntry(state, spec.bucket, entry(linkId, spec.kind, spec.logicalPath, "present", boundedNote(`link -> ${target}`)));
}

function inventoryConfig(content: Buffer, logicalPath: string, state: ScanState): void {
  state.sourcePaths.add(logicalPath);
  let raw: unknown;
  try {
    const text = content.toString("utf8");
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    recordEntry(state, "components", entry(`config-invalid:${logicalPath}`, "config", logicalPath, "degraded", "invalid-config"));
    return;
  }
  const parsed = HarnessConfigSchema.safeParse(raw);
  if (!parsed.success) {
    recordEntry(state, "components", entry(`config-invalid:${logicalPath}`, "config", logicalPath, "degraded", "invalid-config"));
    return;
  }

  const config = parsed.data;
  addEnvName(config.plannerModel?.apiKeyEnvVar, state.envNames);
  for (const fallback of config.plannerModelFallbacks) addEnvName(fallback.apiKeyEnvVar, state.envNames);
  if (config.memory.storage.provider === "postgres") {
    addEnvName(config.memory.storage.postgres.connectionStringEnvVar, state.envNames);
  }
  if (config.memory.honcho.enabled) addEnvName(config.memory.honcho.apiKeyEnvVar, state.envNames);
  inventoryMcpServers(config, logicalPath, state);
}

function inventoryMcpServers(config: HarnessConfig, logicalPath: string, state: ScanState): void {
  for (const server of config.mcpServers) {
    for (const name of server.requiredEnvNames) addEnvName(name, state.envNames);
    const metadata = [
      `transport=${server.transport}`,
      ...(server.command ? [`command=${safeCommandName(server.command)}`] : []),
      ...(server.url ? [`endpoint=${safeEndpoint(server.url)}`] : []),
      ...(server.requiredEnvNames.length > 0 ? [`env=${uniqueSorted(server.requiredEnvNames).join(",")}`] : [])
    ];
    const id = `mcp:${server.id}`;
    if (!state.connections.has(id)) {
      state.connections.set(id, entry(id, "connection", logicalPath, "present", boundedNote(metadata.join("; "))));
    }
  }
}

function inventoryProviders(routes: readonly ProviderRouteDescriptor[], state: ScanState): void {
  for (const route of [...routes].sort((left, right) => compareText(left.routeId, right.routeId))) {
    const envNames = new Set<string>();
    addEnvName(route.credentialSource.envVarName, envNames);
    for (const name of route.credentialSource.envVarNames) addEnvName(name, envNames);
    for (const header of route.wire?.headers ?? []) addEnvName(header.envVar, envNames);
    const endpointEnvName = environmentNameFromReference(route.baseUrl);
    addEnvName(endpointEnvName, envNames);
    const templateEnvName = environmentNameFromReference(route.credentialSource.template);
    addEnvName(templateEnvName, envNames);
    for (const name of envNames) state.envNames.add(name);

    const id = `provider:${route.routeId}`;
    if (state.connections.has(id)) continue;
    const metadata = [
      `route=${route.routeType}`,
      ...(route.baseUrl ? [`endpoint=${safeEndpoint(route.baseUrl)}`] : []),
      ...(envNames.size > 0 ? [`env=${[...envNames].sort(compareText).join(",")}`] : [])
    ];
    state.connections.set(id, entry(id, "connection", undefined, "present", boundedNote(metadata.join("; "))));
  }
}

function reserveFileSlot(state: ScanState, capPath: string): boolean {
  if (state.fileCount >= state.limits.maxFileCount) {
    addLimitEntry(state, "file-count", capPath);
    state.stopped = true;
    return false;
  }
  state.fileCount += 1;
  return true;
}

function addLimitEntry(state: ScanState, kind: "file-count" | "walk-entries", logicalPath: string): void {
  const id = `limit:${kind}`;
  if (state.components.some((candidate) => candidate.id === id)) return;
  state.components.push(entry(id, "component", logicalPath, "degraded", `${kind}-cap`));
}

function addPathLengthEntry(state: ScanState, logicalRoot: string): void {
  const id = "limit:path-length";
  if (state.components.some((candidate) => candidate.id === id)) return;
  state.components.push(entry(id, "component", logicalRoot, "degraded", "path-length-cap"));
}

function recordEntry(state: ScanState, bucket: InventoryBucket, value: InventoryEntry): void {
  state[bucket].push(value);
}

function entry(
  id: string,
  kind: InventoryEntryKind,
  path: string | undefined,
  status: InventoryEntry["status"],
  note?: string
): InventoryEntry {
  return { id, kind, status, ...(path ? { path } : {}), ...(note ? { note: boundedNote(note) } : {}) };
}

function fileSpec(
  root: RestoreInventoryRoot,
  absolutePath: string,
  logicalPath: string,
  bucket: InventoryBucket,
  kind: InventoryEntryKind,
  parseConfig = false
): PortablePathSpec {
  return { root, absolutePath, logicalPath, bucket, kind, ...(parseConfig ? { parseConfig: true } : {}) };
}

function directorySpec(
  root: RestoreInventoryRoot,
  absolutePath: string,
  logicalPath: string,
  bucket: InventoryBucket,
  kind: InventoryEntryKind
): PortablePathSpec {
  return { root, absolutePath, logicalPath, bucket, kind };
}

function createRootIdentity(path: string): RootIdentity {
  let realPath = path;
  try {
    realPath = realpathSync(path);
  } catch {
    // Missing explicit roots are represented by logical missing entries; never create them.
  }
  return { absolutePath: path, realPath };
}

function logicalTargetFor(
  target: string,
  sourceRoot: RestoreInventoryRoot,
  roots: Readonly<Record<RestoreInventoryRoot, RootIdentity | undefined>>
): string | undefined {
  const allowedRoots: readonly RestoreInventoryRoot[] = sourceRoot === "project" ? ["project", "guru-home"] : ["guru-home"];
  for (const rootName of allowedRoots) {
    const root = roots[rootName];
    if (!root) continue;
    const contained = containedRelative(root.realPath, target);
    if (contained !== undefined) return contained.length === 0 ? rootName : `${rootName}/${toPosix(contained)}`;
  }
  return undefined;
}

function containedRelative(root: string, target: string): string | undefined {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return "";
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel;
}

function normalizeLimits(input: Partial<RestoreInventoryLimits> | undefined): RestoreInventoryLimits {
  return {
    maxDepth: boundedPositiveInteger(input?.maxDepth, DEFAULT_LIMITS.maxDepth, HARD_LIMITS.maxDepth),
    maxFileCount: boundedPositiveInteger(input?.maxFileCount, DEFAULT_LIMITS.maxFileCount, HARD_LIMITS.maxFileCount),
    maxTotalBytes: boundedPositiveInteger(input?.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, HARD_LIMITS.maxTotalBytes),
    maxFileBytes: boundedPositiveInteger(input?.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, HARD_LIMITS.maxFileBytes)
  };
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Math.min(maximum, Math.max(1, Number.isFinite(value) ? Math.floor(value as number) : fallback));
}

function maxWalkEntries(limits: RestoreInventoryLimits): number {
  return Math.min(100_000, Math.max(64, limits.maxFileCount * 16));
}

function isRiskyLogicalPath(path: string): boolean {
  const segments = toPosix(path).split("/").map((segment) => segment.toLowerCase());
  const filename = segments.at(-1) ?? "";
  if (filename.startsWith(".env")) return true;
  if (segments.some((segment) => RISKY_SEGMENTS.has(segment))) return true;
  if (segments.some((segment) => /(?:^|[-_.])(credential|auth|vault|secret|token)(?:$|[-_.])/u.test(segment))) return true;
  if (["id_rsa", "id_ed25519", ".npmrc", ".yarnrc", ".netrc", ".ds_store", "thumbs.db"].includes(filename)) return true;
  return RISKY_FILE_SUFFIXES.some((suffix) => filename.endsWith(suffix)) || TEMP_FILE_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

function isBinary(content: Buffer): boolean {
  if (content.includes(0)) return true;
  const sample = content.subarray(0, Math.min(content.length, 8_192));
  let controls = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.2;
}

function readBoundedFile(
  path: string,
  maxBytes: number
): { readonly status: "ok"; readonly content: Buffer } | { readonly status: "oversized" } | { readonly status: "unreadable" } {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return { status: "oversized" };
    return { status: "ok", content: buffer.subarray(0, offset) };
  } catch {
    return { status: "unreadable" };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The inventory never exposes host errors or paths.
      }
    }
  }
}

function environmentNameFromReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(?:os\.environ\/|process\.env\.|\$\{?)([A-Z_][A-Z0-9_]*)\}?$/u.exec(value.trim());
  return match?.[1];
}

function addEnvName(value: string | undefined, names: Set<string>): void {
  if (value && value.length <= MAX_ENV_NAME_LENGTH && ENV_NAME.test(value)) names.add(value);
}

function safeEndpoint(value: string): string {
  const referenceName = environmentNameFromReference(value);
  if (referenceName) return `os.environ/${referenceName}`;
  if (containsSecretValue(value)) return "configured";
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return WINDOWS_DRIVE.test(value) || isAbsolute(value) ? basename(value) : boundedNote(value);
  }
}

function safeCommandName(value: string): string {
  if (containsSecretValue(value)) return "configured";
  return WINDOWS_DRIVE.test(value) || isAbsolute(value) ? basename(value) : boundedNote(value);
}

function boundedNote(value: string): string {
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").trim();
  return normalized.length <= 400 ? normalized : `${normalized.slice(0, 397)}...`;
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function uniqueSortedEntries(values: readonly InventoryEntry[]): InventoryEntry[] {
  return uniqueById(values).sort((left, right) => compareText(left.path ?? left.id, right.path ?? right.id) || compareText(left.id, right.id));
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const value of values) if (!byId.has(value.id)) byId.set(value.id, value);
  return [...byId.values()];
}
