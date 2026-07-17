import { spawn } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import { containsSecretValue, scrubSecretValuesReport } from "../safety/secretSafety.js";
import {
  createRestoreInventory,
  type RestoreInventory,
  type RestoreInventoryAsset,
  type RestoreInventoryLimits,
  type RestoreInventoryRoot
} from "./inventory.js";
import { RestoreManifestSchema, type RestoreManifest, type RestorePackageWriter } from "./manifests.js";

export interface RestorePackageWriterFileSystem {
  /** Test-only hook that runs in the final publication window. */
  readonly beforePublish?: (source: string, target: string) => void;
  /** Test-only hook that runs after the target claim and before entry publication. */
  readonly afterTargetClaim?: (source: string, target: string) => void;
  /** Test-only hook that runs after a recursive directory claim and before publication within it. */
  readonly afterDirectoryClaim?: (source: string, target: string) => void;
}

export interface CreateRestorePackageWriterOptions {
  readonly guruHomeDirectory: string;
  readonly projectRoot?: string;
  readonly providerRoutes?: readonly ProviderRouteDescriptor[];
  readonly limits?: Partial<RestoreInventoryLimits>;
  readonly now?: () => Date;
  /** Narrow test seam for proving final-window races and sibling-temp cleanup. */
  readonly fileSystem?: RestorePackageWriterFileSystem;
}

export type RestorePackageWriterErrorCode =
  | "inventory-changed"
  | "invalid-package"
  | "invalid-target"
  | "target-exists"
  | "unsafe-package"
  | "publish-failed";

export class RestorePackageWriterError extends Error {
  readonly code: RestorePackageWriterErrorCode;

  constructor(code: RestorePackageWriterErrorCode, message: string) {
    super(message);
    this.name = "RestorePackageWriterError";
    this.code = code;
  }
}

interface CandidatePayload {
  readonly packagePath: string;
  readonly content: Buffer;
}

interface RestorePackageCandidate {
  readonly manifest: RestoreManifest;
  readonly manifestText: string;
  readonly environmentExample: string;
  readonly payloads: readonly CandidatePayload[];
}

interface ScanInput {
  readonly logicalPath: string;
  readonly text: string;
}

const MANIFEST_FILE_NAME = "restore-manifest.json";
const ENVIRONMENT_EXAMPLE_FILE_NAME = ".env.example";
const SCANNER_NAME = "guruharness-secret-scan";
const MANIFEST_VERSION = "1.0.0";
const MAX_VERIFICATION_DEPTH = 20;
const MAX_VERIFICATION_FILE_COUNT = 5_002;
const MAX_VERIFICATION_FILE_BYTES = 2 * 1024 * 1024;
const MAX_VERIFICATION_TOTAL_BYTES = 50 * 1024 * 1024 + 4 * 1024 * 1024;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;
/**
 * Publish from a dedicated process whose cwd is the claimed directory.
 * The process verifies that acquired cwd against the claim identity before
 * writing; relative operations then stay inode-bound across path replacement.
 * Recursive claims repeat the same acquire-verify-bind protocol.
 */
const DIRECTORY_PUBLISH_WORKER = String.raw`
const { spawn } = require("node:child_process");
const { linkSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const workerSource = process.argv[1];
const payload = JSON.parse(process.argv[2]);
const pendingClaims = new Map();
const forwardedClaims = new Map();
let nextClaim = 0;

function identity(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertClaimedDirectory(path, expected) {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(identity(stats), expected)) {
    throw new Error("claimed-directory-changed");
  }
}

function requestClaim(logicalPath) {
  return new Promise((resolve, reject) => {
    const id = process.pid + ":" + String(nextClaim++);
    pendingClaims.set(id, { resolve, reject });
    process.send({ type: "claim", id, logicalPath });
  });
}

function runChild(childPayload, childDirectory) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const child = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", workerSource, workerSource, JSON.stringify(childPayload)],
      { cwd: childDirectory, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true }
    );

    child.on("message", (message) => {
      if (message && message.type === "claim" && typeof message.id === "string") {
        forwardedClaims.set(message.id, child);
        process.send(message);
      } else if (message && message.type === "done") {
        completed = true;
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 && completed) resolve();
      else reject(new Error("directory-publish-child-failed"));
    });
  });
}

process.on("message", (message) => {
  if (!message || (message.type !== "continue" && message.type !== "abort") || typeof message.id !== "string") return;
  const forwarded = forwardedClaims.get(message.id);
  if (forwarded) {
    forwardedClaims.delete(message.id);
    forwarded.send(message);
    return;
  }
  const pending = pendingClaims.get(message.id);
  if (!pending) return;
  pendingClaims.delete(message.id);
  if (message.type === "continue") pending.resolve();
  else pending.reject(new Error("directory-claim-hook-failed"));
});

async function publish() {
  assertClaimedDirectory(".", payload.expectedIdentity);
  for (const entry of readdirSync(payload.sourceDirectory).sort((left, right) => left.localeCompare(right, "en"))) {
    const source = join(payload.sourceDirectory, entry);
    const stats = lstatSync(source);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      mkdirSync(entry, { mode: stats.mode & 0o777 });
      const claimedIdentity = identity(lstatSync(entry));
      const logicalPath = payload.logicalDirectory ? join(payload.logicalDirectory, entry) : entry;
      await requestClaim(logicalPath);
      await runChild(
        { sourceDirectory: source, expectedIdentity: claimedIdentity, logicalDirectory: logicalPath },
        entry
      );
      assertClaimedDirectory(entry, claimedIdentity);
      continue;
    }
    if (stats.isFile() && !stats.isSymbolicLink()) {
      linkSync(source, entry);
      unlinkSync(source);
      continue;
    }
    throw new Error("unsupported-staging-entry");
  }
  rmdirSync(payload.sourceDirectory);
}

publish()
  .then(() => {
    process.send({ type: "done" });
    process.disconnect();
  })
  .catch(() => {
    process.send({ type: "failed" });
    process.disconnect();
    process.exitCode = 1;
  });
`;

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface DirectoryPublishWorkerPayload {
  readonly sourceDirectory: string;
  readonly expectedIdentity: DirectoryIdentity;
  readonly logicalDirectory: string;
}

interface DirectoryPublishWorkerMessage {
  readonly type: "claim" | "done" | "failed";
  readonly id?: string;
  readonly logicalPath?: string;
}

/** Create a scan-before-publish writer for one explicit Guru profile/project pair. */
export function createRestorePackageWriter(options: CreateRestorePackageWriterOptions): RestorePackageWriter {
  const normalized = normalizeOptions(options);

  return {
    generate: async () => (await buildCandidate(normalized)).manifest,
    write: async (targetDirectory) => writeCandidate(await buildCandidate(normalized), targetDirectory, normalized.fileSystem)
  };
}

/** Verify one relocated restore package without mutating it or consulting its source machine. */
export async function verifyRestorePackage(packageDirectory: string): Promise<RestoreManifest> {
  try {
    return verifyRestorePackageSync(resolve(packageDirectory));
  } catch (error) {
    if (error instanceof RestorePackageWriterError) throw error;
    throw invalidPackageError();
  }
}

interface NormalizedOptions {
  readonly guruHomeDirectory: string;
  readonly projectRoot?: string;
  readonly providerRoutes?: readonly ProviderRouteDescriptor[];
  readonly limits?: Partial<RestoreInventoryLimits>;
  readonly now: () => Date;
  readonly fileSystem: RestorePackageWriterFileSystem;
}

function normalizeOptions(options: CreateRestorePackageWriterOptions): NormalizedOptions {
  return {
    guruHomeDirectory: resolve(options.guruHomeDirectory),
    ...(options.projectRoot ? { projectRoot: resolve(options.projectRoot) } : {}),
    ...(options.providerRoutes ? { providerRoutes: options.providerRoutes } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    now: options.now ?? (() => new Date()),
    fileSystem: options.fileSystem ?? {}
  };
}

async function buildCandidate(options: NormalizedOptions): Promise<RestorePackageCandidate> {
  const inventory = createRestoreInventory({
    guruHomeDirectory: options.guruHomeDirectory,
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options.providerRoutes ? { providerRoutes: options.providerRoutes } : {}),
    ...(options.limits ? { limits: options.limits } : {})
  });
  const payloads = snapshotPayloads(inventory, options);
  const timestamp = options.now().toISOString();
  const environmentExample = inventory.configSummary.envNames.map((name) => `${name}=\n`).join("");
  const provisional = createManifest(inventory, timestamp, []);
  const sourceRoots = [options.guruHomeDirectory, ...(options.projectRoot ? [options.projectRoot] : [])];
  const initialInputs: ScanInput[] = [
    ...manifestScanInputs(provisional),
    ...environmentExampleScanInputs(environmentExample),
    ...payloads.map((payload) => ({ logicalPath: payload.packagePath, text: payload.content.toString("utf8") }))
  ];
  let findings = scanCandidate(initialInputs, sourceRoots);
  let manifest = createManifest(inventory, timestamp, findings);
  let manifestText = serializeManifest(manifest);

  const finalManifestFindings = scanCandidate(manifestScanInputs(manifest), sourceRoots);
  findings = uniqueSorted([...findings, ...finalManifestFindings]);
  if (findings.length !== manifest.secretScan.findings.length) {
    manifest = createManifest(inventory, timestamp, findings);
    manifestText = serializeManifest(manifest);
  }

  return { manifest, manifestText, environmentExample, payloads };
}

function createManifest(inventory: RestoreInventory, timestamp: string, findings: readonly string[]): RestoreManifest {
  return RestoreManifestSchema.parse({
    version: MANIFEST_VERSION,
    generatedAt: timestamp,
    harness: "GuruHarness",
    components: inventory.components,
    configSummary: inventory.configSummary,
    connections: inventory.connections,
    skillsIndex: inventory.skillsIndex,
    toolsIndex: inventory.toolsIndex,
    secretScan: {
      scannedAt: timestamp,
      scanner: SCANNER_NAME,
      leakedSecretCount: findings.length,
      findings
    }
  });
}

async function writeCandidate(
  candidate: RestorePackageCandidate,
  requestedTarget: string,
  fileSystem: RestorePackageWriterFileSystem
): Promise<RestoreManifest> {
  if (candidate.manifest.secretScan.leakedSecretCount > 0) {
    throw new RestorePackageWriterError(
      "unsafe-package",
      `Restore package refused: ${candidate.manifest.secretScan.leakedSecretCount} unsafe finding(s).`
    );
  }

  const target = resolve(requestedTarget);
  const parent = dirname(target);
  const targetName = basename(target);
  if (target === parent || targetName.length === 0) {
    throw new RestorePackageWriterError("invalid-target", "Restore package target is invalid.");
  }
  assertExistingDirectory(parent);
  assertTargetAbsent(target);

  let temporaryDirectory: string | undefined;
  let published = false;
  try {
    temporaryDirectory = mkdtempSync(join(parent, `.${targetName}.restore-`));
    writeCandidateFiles(temporaryDirectory, candidate);
    assertTargetAbsent(target);
    fileSystem.beforePublish?.(temporaryDirectory, target);
    await publishDirectoryNoClobber(temporaryDirectory, target, fileSystem);
    published = true;
    return candidate.manifest;
  } catch (error) {
    if (error instanceof RestorePackageWriterError) throw error;
    throw new RestorePackageWriterError("publish-failed", "Restore package could not be published.");
  } finally {
    if (!published && temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * Claim the destination without replacement before moving the scanned package.
 * Node's directory rename can replace an empty destination on POSIX, so a
 * check-then-rename cannot uphold the existing-target preservation contract.
 */
async function publishDirectoryNoClobber(
  source: string,
  target: string,
  fileSystem: RestorePackageWriterFileSystem
): Promise<void> {
  try {
    mkdirSync(target);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new RestorePackageWriterError("target-exists", "Restore package target already exists and was left untouched.");
    }
    throw error;
  }

  const claimedIdentity = directoryIdentity(lstatSync(target));
  try {
    fileSystem.afterTargetClaim?.(source, target);
    await runDirectoryPublishWorker(
      { sourceDirectory: source, expectedIdentity: claimedIdentity, logicalDirectory: "" },
      target,
      source,
      fileSystem
    );
    assertClaimedDirectory(target, claimedIdentity);
  } catch (error) {
    // The target was claimed by this writer, but it is now externally visible.
    // Never remove it on failure because another process may have added state.
    throw error;
  }
}

function runDirectoryPublishWorker(
  payload: DirectoryPublishWorkerPayload,
  target: string,
  source: string,
  fileSystem: RestorePackageWriterFileSystem
): Promise<void> {
  return new Promise((resolveWorker, rejectWorker) => {
    let completed = false;
    const child = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", DIRECTORY_PUBLISH_WORKER, DIRECTORY_PUBLISH_WORKER, JSON.stringify(payload)],
      { cwd: target, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true }
    );

    child.on("message", (message: unknown) => {
      if (!isDirectoryPublishWorkerMessage(message)) return;
      if (message.type === "done") {
        completed = true;
        return;
      }
      if (message.type !== "claim" || !message.id || !message.logicalPath) return;
      try {
        fileSystem.afterDirectoryClaim?.(join(source, message.logicalPath), join(target, message.logicalPath));
        child.send({ type: "continue", id: message.id });
      } catch {
        child.send({ type: "abort", id: message.id });
      }
    });
    child.once("error", rejectWorker);
    child.once("exit", (code) => {
      if (code === 0 && completed) resolveWorker();
      else rejectWorker(new Error("Restore package directory publication failed."));
    });
  });
}

function isDirectoryPublishWorkerMessage(value: unknown): value is DirectoryPublishWorkerMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { readonly type?: unknown }).type;
  return type === "claim" || type === "done" || type === "failed";
}

function directoryIdentity(stats: Stats): DirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function assertClaimedDirectory(path: string, expected: DirectoryIdentity): void {
  const stats = lstatSync(path);
  const actual = directoryIdentity(stats);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error("Restore package claimed directory changed during publication.");
  }
}

function writeCandidateFiles(temporaryDirectory: string, candidate: RestorePackageCandidate): void {
  writeExclusive(join(temporaryDirectory, MANIFEST_FILE_NAME), candidate.manifestText);
  writeExclusive(join(temporaryDirectory, ENVIRONMENT_EXAMPLE_FILE_NAME), candidate.environmentExample);

  for (const payload of candidate.payloads) {
    const target = containedPackagePath(temporaryDirectory, payload.packagePath);
    mkdirSync(dirname(target), { recursive: true });
    writeExclusive(target, payload.content);
  }
}

function writeExclusive(path: string, content: string | Buffer): void {
  writeFileSync(path, content, { flag: "wx" });
}

function verifyRestorePackageSync(packageDirectory: string): RestoreManifest {
  assertVerificationRoot(packageDirectory);
  const files = collectVerificationFiles(packageDirectory);
  const manifestText = requiredPackageText(files, MANIFEST_FILE_NAME);
  const environmentExample = requiredPackageText(files, ENVIRONMENT_EXAMPLE_FILE_NAME);
  const manifest = parseRestoreManifest(manifestText);

  assertPortableManifestPaths(manifest);
  assertEnvironmentExample(manifest, environmentExample);
  assertListedPayloads(manifest, files);

  const scanInputs: ScanInput[] = [
    ...manifestScanInputs(manifest),
    ...environmentExampleScanInputs(environmentExample),
    ...[...files.entries()]
      .filter(([path]) => path !== MANIFEST_FILE_NAME && path !== ENVIRONMENT_EXAMPLE_FILE_NAME)
      .map(([logicalPath, content]) => ({ logicalPath, text: content.toString("utf8") }))
  ];
  const findings = scanCandidate(scanInputs, []);
  if (
    findings.length > 0 ||
    manifest.secretScan.leakedSecretCount > 0 ||
    manifest.secretScan.findings.length > 0 ||
    manifest.secretScan.leakedSecretCount !== manifest.secretScan.findings.length
  ) {
    throw new RestorePackageWriterError("unsafe-package", "Restore package verification found unsafe content.");
  }
  return manifest;
}

function assertVerificationRoot(packageDirectory: string): void {
  try {
    const stats = lstatSync(packageDirectory);
    if (stats.isDirectory() && !stats.isSymbolicLink()) return;
  } catch {
    // Fall through to the same value-free package error.
  }
  throw invalidPackageError();
}

function collectVerificationFiles(packageDirectory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const realRoot = realpathSync(packageDirectory);
  let fileCount = 0;
  let totalBytes = 0;

  const visit = (directory: string, logicalDirectory: string, depth: number): void => {
    if (depth > MAX_VERIFICATION_DEPTH) throw invalidPackageError();
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const logicalPath = logicalDirectory ? `${logicalDirectory}/${entry.name}` : entry.name;
      if (logicalPath.length > 1_024 || !isPortableRelativePath(logicalPath)) throw invalidPackageError();
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw invalidPackageError();
      if (entry.isDirectory()) {
        visit(path, logicalPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !lstatSync(path).isFile() || !isContained(realRoot, realpathSync(path))) throw invalidPackageError();
      fileCount += 1;
      if (fileCount > MAX_VERIFICATION_FILE_COUNT) throw invalidPackageError();
      const read = readBoundedFile(path, MAX_VERIFICATION_FILE_BYTES);
      if (read.status !== "ok" || isBinaryContent(read.content)) throw invalidPackageError();
      totalBytes += read.content.byteLength;
      if (totalBytes > MAX_VERIFICATION_TOTAL_BYTES) throw invalidPackageError();
      files.set(logicalPath, Buffer.from(read.content));
    }
  };

  visit(packageDirectory, "", 0);
  return files;
}

function requiredPackageText(files: ReadonlyMap<string, Buffer>, logicalPath: string): string {
  const content = files.get(logicalPath);
  if (!content) throw invalidPackageError();
  return content.toString("utf8");
}

function parseRestoreManifest(text: string): RestoreManifest {
  try {
    return RestoreManifestSchema.parse(JSON.parse(text) as unknown);
  } catch {
    throw invalidPackageError();
  }
}

function assertPortableManifestPaths(manifest: RestoreManifest): void {
  const entries = [...manifest.components, ...manifest.connections, ...manifest.skillsIndex, ...manifest.toolsIndex];
  for (const path of [...manifest.configSummary.sourcePaths, ...entries.flatMap((entry) => (entry.path ? [entry.path] : []))]) {
    if (!isPortableRelativePath(path)) throw invalidPackageError();
  }
}

function assertEnvironmentExample(manifest: RestoreManifest, text: string): void {
  const envNames = manifest.configSummary.envNames;
  if (envNames.some((name) => name.length > 256 || !ENVIRONMENT_NAME.test(name))) throw invalidPackageError();
  if (envNames.join("\n") !== uniqueSorted(envNames).join("\n")) throw invalidPackageError();
  const expected = envNames.map((name) => `${name}=\n`).join("");
  if (text !== expected) throw invalidPackageError();
}

function assertListedPayloads(manifest: RestoreManifest, files: ReadonlyMap<string, Buffer>): void {
  const entries = [...manifest.components, ...manifest.skillsIndex, ...manifest.toolsIndex];
  const listed = new Set<string>();
  for (const entry of entries) {
    if (!entry.id.startsWith("asset:")) continue;
    if (!entry.path || entry.id !== `asset:${entry.path}` || entry.status !== "present") throw invalidPackageError();
    const packagePath = `assets/${entry.path}`;
    validateVerificationPackagePath(packagePath);
    if (!files.has(packagePath)) throw invalidPackageError();
    listed.add(packagePath);
  }

  for (const path of files.keys()) {
    if (path === MANIFEST_FILE_NAME || path === ENVIRONMENT_EXAMPLE_FILE_NAME) continue;
    validateVerificationPackagePath(path);
    if (!listed.has(path)) throw invalidPackageError();
  }
}

function validateVerificationPackagePath(path: string): void {
  if (!path.startsWith("assets/") || !isPortableRelativePath(path)) throw invalidPackageError();
}

function isBinaryContent(content: Buffer): boolean {
  if (content.includes(0)) return true;
  const sample = content.subarray(0, Math.min(content.length, 8_192));
  let controls = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.2;
}

function invalidPackageError(): RestorePackageWriterError {
  return new RestorePackageWriterError("invalid-package", "Restore package verification failed.");
}

function snapshotPayloads(inventory: RestoreInventory, options: NormalizedOptions): CandidatePayload[] {
  const payloads: CandidatePayload[] = [];
  let totalBytes = 0;
  for (const asset of inventory.assets) {
    const source = sourcePathForAsset(asset, options);
    assertRegularContainedSource(source, asset.root, options);
    const read = readBoundedFile(source, inventory.limits.maxFileBytes);
    if (read.status !== "ok" || read.content.byteLength !== asset.bytes) {
      throw new RestorePackageWriterError("inventory-changed", "Restore inventory changed during package generation.");
    }
    totalBytes += read.content.byteLength;
    if (totalBytes > inventory.limits.maxTotalBytes) {
      throw new RestorePackageWriterError("inventory-changed", "Restore inventory changed during package generation.");
    }
    validatePackagePath(asset.packagePath);
    payloads.push({ packagePath: asset.packagePath, content: read.content });
  }
  return payloads.sort((left, right) => compareText(left.packagePath, right.packagePath));
}

function sourcePathForAsset(asset: RestoreInventoryAsset, options: NormalizedOptions): string {
  const prefix = `${asset.root}/`;
  if (!asset.path.startsWith(prefix)) {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory contains an invalid logical asset path.");
  }
  const relativePath = asset.path.slice(prefix.length);
  if (!isPortableRelativePath(relativePath)) {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory contains an invalid logical asset path.");
  }
  const root = asset.root === "guru-home" ? options.guruHomeDirectory : options.projectRoot;
  if (!root) {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory references an unavailable source root.");
  }
  const source = resolve(root, ...relativePath.split("/"));
  if (!isContained(root, source)) {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory contains an escaping source path.");
  }
  return source;
}

function assertRegularContainedSource(source: string, rootName: RestoreInventoryRoot, options: NormalizedOptions): void {
  let stats: Stats;
  try {
    stats = lstatSync(source);
  } catch {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory source is unavailable.");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory source is no longer a regular file.");
  }
  const root = rootName === "guru-home" ? options.guruHomeDirectory : options.projectRoot;
  if (!root) {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory references an unavailable source root.");
  }
  try {
    if (!isContained(realpathSync(root), realpathSync(source))) {
      throw new RestorePackageWriterError("inventory-changed", "Restore inventory source resolves outside its root.");
    }
  } catch (error) {
    if (error instanceof RestorePackageWriterError) throw error;
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory source containment could not be verified.");
  }
}

function readBoundedFile(path: string, maxBytes: number): { readonly status: "ok"; readonly content: Buffer } | { readonly status: "failed" } {
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
    if (offset > maxBytes) return { status: "failed" };
    return { status: "ok", content: buffer.subarray(0, offset) };
  } catch {
    return { status: "failed" };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Never surface host paths or raw errors from package generation.
      }
    }
  }
}

function scanCandidate(inputs: readonly ScanInput[], sourceRoots: readonly string[]): string[] {
  const findings = new Set<string>();
  const sourceVariants = sourcePathVariants(sourceRoots);
  for (const input of inputs) {
    const report = scrubSecretValuesReport(input.text);
    for (const pattern of report.matched) findings.add(boundedFinding(input.logicalPath, pattern));
    if (containsSecretValue(input.text) && report.matched.length === 0) {
      findings.add(boundedFinding(input.logicalPath, "secret-shape"));
    }
    if (containsAny(input.text, sourceVariants)) findings.add(boundedFinding(input.logicalPath, "source-path"));
  }
  return [...findings].sort(compareText);
}

function manifestScanInputs(manifest: RestoreManifest): ScanInput[] {
  // Schema keys and numeric fields are fixed by RestoreManifestSchema. Scan every
  // data-bearing string separately so JSON syntax cannot look like a credential
  // assignment while every variable manifest value still uses the canonical scan.
  const inputs: ScanInput[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      inputs.push({ logicalPath: MANIFEST_FILE_NAME, text: value });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(manifest);
  return inputs;
}

function environmentExampleScanInputs(text: string): ScanInput[] {
  // Each generated line intentionally ends at NAME=. Keeping lines separate stops
  // assignment scanning from consuming the next variable name as the prior value.
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({ logicalPath: ENVIRONMENT_EXAMPLE_FILE_NAME, text: line }));
}

function sourcePathVariants(roots: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const root of roots) {
    const resolved = resolve(root);
    const candidates = [resolved, resolved.replaceAll("\\", "/"), JSON.stringify(resolved).slice(1, -1)];
    for (const candidate of candidates) {
      if (candidate.length >= 3) variants.add(process.platform === "win32" ? candidate.toLocaleLowerCase() : candidate);
    }
  }
  return [...variants].sort(compareText);
}

function containsAny(text: string, variants: readonly string[]): boolean {
  const haystack = process.platform === "win32" ? text.toLocaleLowerCase() : text;
  return variants.some((variant) => haystack.includes(variant));
}

function boundedFinding(logicalPath: string, pattern: string): string {
  const suffix = `:${pattern}`;
  const maximumPathLength = 400 - suffix.length;
  if (logicalPath.length <= maximumPathLength) return `${logicalPath}${suffix}`;
  const headLength = Math.floor((maximumPathLength - 3) / 2);
  const tailLength = maximumPathLength - headLength - 3;
  return `${logicalPath.slice(0, headLength)}...${logicalPath.slice(-tailLength)}${suffix}`;
}

function serializeManifest(manifest: RestoreManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function validatePackagePath(path: string): void {
  if (!path.startsWith("assets/") || !isPortableRelativePath(path)) {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory contains an invalid package path.");
  }
}

function isPortableRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes("\\") || path.includes("\0") || isAbsolute(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function containedPackagePath(root: string, logicalPath: string): string {
  validatePackagePath(logicalPath);
  const target = resolve(root, ...logicalPath.split("/"));
  if (!isContained(root, target)) {
    throw new RestorePackageWriterError("inventory-changed", "Restore inventory contains an escaping package path.");
  }
  return target;
}

function isContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function assertExistingDirectory(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) return;
  } catch {
    // Fall through to a value-free error.
  }
  throw new RestorePackageWriterError("invalid-target", "Restore package target parent must be an existing directory.");
}

function assertTargetAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw new RestorePackageWriterError("invalid-target", "Restore package target could not be inspected.");
  }
  throw new RestorePackageWriterError("target-exists", "Restore package target already exists and was left untouched.");
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "EEXIST";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
