import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

import { commandExists, resolveWindowsGateSpawn } from "../review/gates.js";
import {
  connectContentLengthJsonRpc,
  type ContentLengthJsonRpcConnection,
  type ContentLengthJsonRpcNotificationSubscription,
  type ContentLengthJsonRpcOptions,
  type ContentLengthJsonRpcWaitOptions
} from "./contentLengthJsonRpc.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTICS = 200;
const DEFAULT_MAX_LOCATIONS = 200;
const DEFAULT_MAX_HOVER_CHARS = 12_000;
const MAX_DIAGNOSTIC_NOTIFICATIONS = 64;
const MAX_DIAGNOSTIC_TEXT_CHARS = 2_000;
const MAX_SOURCE_CHARS = 200;
const MAX_URI_CHARS = 4_000;
const MAX_PROTOCOL_POSITION = 10_000_000;

const UNSAFE_CONTROL_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export interface TypeScriptLanguageServerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ResolveTypeScriptLanguageServerOptions {
  readonly platform?: NodeJS.Platform;
  readonly commandExists?: (name: string) => boolean;
  readonly resolveSpawn?: (command: readonly string[]) => { readonly executable: string; readonly args: string[] };
}

export type TypeScriptLanguageServerResolver = (
  repoRoot: string
) => TypeScriptLanguageServerCommand | null | Promise<TypeScriptLanguageServerCommand | null>;

export type TypeScriptLanguageServerConnectionFactory = (
  command: TypeScriptLanguageServerCommand,
  repoRoot: string
) => ContentLengthJsonRpcConnection;

export interface TypeScriptLanguageServerFileRequest {
  readonly repoRoot: string;
  readonly filePath: string;
  readonly signal?: AbortSignal;
}

export interface TypeScriptLanguageServerPositionRequest extends TypeScriptLanguageServerFileRequest {
  readonly line: number;
  readonly character: number;
}

export interface TypeScriptLanguageServerPosition {
  readonly line: number;
  readonly character: number;
}

export interface TypeScriptLanguageServerRange {
  readonly start: TypeScriptLanguageServerPosition;
  readonly end: TypeScriptLanguageServerPosition;
}

export interface TypeScriptLanguageServerDiagnostic {
  readonly range: TypeScriptLanguageServerRange;
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export type TypeScriptLanguageServerLocation =
  | { readonly path: string; readonly range: TypeScriptLanguageServerRange }
  | { readonly uri: string; readonly range: TypeScriptLanguageServerRange };

export interface TypeScriptLanguageServerAdapter {
  /** Availability probe only. It never creates a connection or starts a server process. */
  status(repoRoot: string): Promise<boolean>;
  diagnostics(input: TypeScriptLanguageServerFileRequest): Promise<readonly TypeScriptLanguageServerDiagnostic[]>;
  definition(input: TypeScriptLanguageServerPositionRequest): Promise<readonly TypeScriptLanguageServerLocation[]>;
  references(input: TypeScriptLanguageServerPositionRequest): Promise<readonly TypeScriptLanguageServerLocation[]>;
  hover(input: TypeScriptLanguageServerPositionRequest): Promise<string | null>;
}

export interface TypeScriptLanguageServerAdapterOptions {
  readonly resolver?: TypeScriptLanguageServerResolver;
  readonly connect?: TypeScriptLanguageServerConnectionFactory;
  readonly requestTimeoutMs?: number;
  readonly maxFileBytes?: number;
  readonly maxDiagnostics?: number;
  readonly maxLocations?: number;
  readonly maxHoverChars?: number;
}

export class TypeScriptLanguageServerUnavailableError extends Error {
  constructor() {
    super("typescript-language-server is unavailable; install it in the project or place it on PATH.");
    this.name = "TypeScriptLanguageServerUnavailableError";
  }
}

interface PreparedDocument {
  readonly repoRoot: string;
  readonly filePath: string;
  readonly uri: string;
  readonly languageId: string;
  readonly text: string;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) {
      return false;
    }
    if (platform !== "win32") {
      await access(path, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeResolvedCommand(
  argv: readonly string[],
  platform: NodeJS.Platform,
  resolveSpawn: ResolveTypeScriptLanguageServerOptions["resolveSpawn"]
): TypeScriptLanguageServerCommand {
  if (platform !== "win32") {
    return { command: argv[0] ?? "", args: argv.slice(1) };
  }
  const resolved = (resolveSpawn ?? resolveWindowsGateSpawn)(argv);
  return { command: resolved.executable, args: resolved.args };
}

/** Resolve only a repo-local or already-on-PATH server. This function never invokes npx. */
export async function resolveTypeScriptLanguageServerCommand(
  repoRoot: string,
  options: ResolveTypeScriptLanguageServerOptions = {}
): Promise<TypeScriptLanguageServerCommand | null> {
  const platform = options.platform ?? process.platform;
  const localBin = join(resolve(repoRoot), "node_modules", ".bin");
  const localNames = platform === "win32"
    ? ["typescript-language-server.cmd", "typescript-language-server"]
    : ["typescript-language-server"];

  for (const name of localNames) {
    const candidate = join(localBin, name);
    if (await isExecutableFile(candidate, platform)) {
      return normalizeResolvedCommand([candidate, "--stdio"], platform, options.resolveSpawn);
    }
  }

  if (!(options.commandExists ?? commandExists)("typescript-language-server")) {
    return null;
  }
  return normalizeResolvedCommand(
    ["typescript-language-server", "--stdio"],
    platform,
    options.resolveSpawn
  );
}

function encodeUriPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/u.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
}

export function pathToLspFileUri(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") {
    // Host-independent: pathToFileURL follows the runner OS and breaks "linux" URIs on Windows CI.
    const normalized = path.replace(/\\/gu, "/");
    if (!normalized.startsWith("/")) {
      throw new Error("POSIX LSP file paths must be absolute.");
    }
    return `file://${encodeUriPath(normalized)}`;
  }
  const normalized = path.replace(/\\/gu, "/");
  if (/^[A-Za-z]:\//u.test(normalized)) {
    return `file:///${encodeUriPath(normalized)}`;
  }
  if (normalized.startsWith("//")) {
    const withoutPrefix = normalized.slice(2);
    const slash = withoutPrefix.indexOf("/");
    const host = slash < 0 ? withoutPrefix : withoutPrefix.slice(0, slash);
    const pathname = slash < 0 ? "" : withoutPrefix.slice(slash);
    return `file://${host}${encodeUriPath(pathname)}`;
  }
  throw new Error("Windows LSP file paths must be absolute drive or UNC paths.");
}

export function lspFileUriToPath(uri: string, platform: NodeJS.Platform = process.platform): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== "file:") {
    throw new Error("LSP location URI is not a file URI.");
  }
  if (platform !== "win32") {
    // Host-independent POSIX path decode (fileURLToPath is OS-specific on Windows).
    const pathname = decodeURIComponent(parsed.pathname);
    if (parsed.hostname && parsed.hostname !== "" && parsed.hostname !== "localhost") {
      return `//${parsed.hostname}${pathname}`;
    }
    return pathname;
  }
  const pathname = decodeURIComponent(parsed.pathname);
  if (parsed.hostname && parsed.hostname !== "localhost") {
    return `\\\\${parsed.hostname}${pathname.replace(/\//gu, "\\")}`;
  }
  const drivePath = /^\/[A-Za-z]:\//u.test(pathname) ? pathname.slice(1) : pathname;
  if (!/^[A-Za-z]:\//u.test(drivePath)) {
    throw new Error("Windows LSP file URI does not contain an absolute drive path.");
  }
  return drivePath.replace(/\//gu, "\\");
}

export function languageIdForTypeScriptFile(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    default:
      throw new Error("TypeScript language-server supports only .ts, .tsx, .js, and .jsx files.");
  }
}

function isContained(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const rel = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

function repoRelativePath(root: string, target: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === "win32" ? win32 : posix;
  return pathApi.relative(pathApi.resolve(root), pathApi.resolve(target)).split(pathApi.sep).join("/");
}

function sanitizeText(value: string, maxChars: number): string {
  return value.replace(UNSAFE_CONTROL_BYTES, "").slice(0, maxChars);
}

async function prepareDocument(
  input: TypeScriptLanguageServerFileRequest,
  maxFileBytes: number
): Promise<PreparedDocument> {
  const canonicalRoot = await realpath(resolve(input.repoRoot));
  if (!(await stat(canonicalRoot)).isDirectory()) {
    throw new Error("LSP repoRoot must be a directory.");
  }
  // Resolve then realpath before containment checks so Windows short/long path aliases match.
  const resolvedCandidate = isAbsolute(input.filePath)
    ? resolve(input.filePath)
    : resolve(canonicalRoot, input.filePath);
  let canonicalFile: string;
  try {
    canonicalFile = await realpath(resolvedCandidate);
  } catch {
    throw new Error("LSP file must be contained inside the active repository.");
  }
  if (!isContained(canonicalRoot, canonicalFile)) {
    throw new Error("LSP file must be contained inside the active repository after resolving links.");
  }
  const fileStats = await stat(canonicalFile);
  if (!fileStats.isFile()) {
    throw new Error("LSP target must be a regular file.");
  }
  if (fileStats.size > maxFileBytes) {
    throw new Error(`LSP file exceeds the ${maxFileBytes}-byte size cap.`);
  }
  const bytes = await readFile(canonicalFile);
  if (bytes.byteLength > maxFileBytes) {
    throw new Error(`LSP file exceeds the ${maxFileBytes}-byte size cap.`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("LSP target is not valid UTF-8 text.");
  }
  return {
    repoRoot: canonicalRoot,
    filePath: canonicalFile,
    uri: pathToLspFileUri(canonicalFile),
    languageId: languageIdForTypeScriptFile(canonicalFile),
    text
  };
}

function assertPosition(text: string, line: number, character: number): void {
  if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) {
    throw new Error("LSP position line and character must be non-negative safe integers.");
  }
  const lines = text.split("\n");
  if (line >= lines.length) {
    throw new Error("LSP position line is outside the opened file.");
  }
  const lineText = (lines[line] ?? "").replace(/\r$/u, "");
  if (character > lineText.length) {
    throw new Error("LSP position character is outside the opened line.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function protocolPosition(value: unknown): TypeScriptLanguageServerPosition | null {
  const record = asRecord(value);
  if (!record) return null;
  const { line, character } = record;
  if (
    typeof line !== "number" || !Number.isSafeInteger(line) || line < 0 || line > MAX_PROTOCOL_POSITION ||
    typeof character !== "number" || !Number.isSafeInteger(character) || character < 0 || character > MAX_PROTOCOL_POSITION
  ) {
    return null;
  }
  return { line, character };
}

function protocolRange(value: unknown): TypeScriptLanguageServerRange | null {
  const record = asRecord(value);
  if (!record) return null;
  const start = protocolPosition(record.start);
  const end = protocolPosition(record.end);
  return start && end ? { start, end } : null;
}

async function normalizeLocation(
  value: unknown,
  repoRoot: string,
  platform: NodeJS.Platform = process.platform
): Promise<TypeScriptLanguageServerLocation | null> {
  const record = asRecord(value);
  if (!record) return null;
  const uri = typeof record.targetUri === "string"
    ? record.targetUri
    : typeof record.uri === "string"
      ? record.uri
      : null;
  const range = protocolRange(record.targetSelectionRange ?? record.targetRange ?? record.range);
  if (!uri || !range) return null;

  try {
    let targetPath = lspFileUriToPath(uri, platform);
    // realpath both sides so Windows 8.3 short paths match long repo roots.
    try {
      targetPath = await realpath(targetPath);
    } catch {
      // keep decoded path
    }
    let root = repoRoot;
    try {
      root = await realpath(repoRoot);
    } catch {
      // keep prepared root
    }
    if (isContained(root, targetPath, platform)) {
      return { path: repoRelativePath(root, targetPath, platform), range };
    }
  } catch {
    // Non-file and malformed external URIs remain URI-labelled below.
  }
  return { uri: sanitizeText(uri, MAX_URI_CHARS), range };
}

async function normalizeLocations(
  value: unknown,
  repoRoot: string,
  maxLocations: number
): Promise<readonly TypeScriptLanguageServerLocation[]> {
  const raw = value == null ? [] : Array.isArray(value) ? value : [value];
  const locations: TypeScriptLanguageServerLocation[] = [];
  for (const candidate of raw) {
    const normalized = await normalizeLocation(candidate, repoRoot);
    if (normalized) locations.push(normalized);
    if (locations.length >= maxLocations) break;
  }
  return locations;
}

function normalizeDiagnostics(value: unknown, maxDiagnostics: number): readonly TypeScriptLanguageServerDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: TypeScriptLanguageServerDiagnostic[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    const range = protocolRange(record?.range);
    if (!record || !range || typeof record.message !== "string") continue;
    const severity = typeof record.severity === "number" && Number.isSafeInteger(record.severity)
      ? record.severity
      : undefined;
    const code = typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined;
    const source = typeof record.source === "string" ? sanitizeText(record.source, MAX_SOURCE_CHARS) : undefined;
    diagnostics.push({
      range,
      ...(severity !== undefined ? { severity } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(source !== undefined ? { source } : {}),
      message: sanitizeText(record.message, MAX_DIAGNOSTIC_TEXT_CHARS)
    });
    if (diagnostics.length >= maxDiagnostics) break;
  }
  return diagnostics;
}

function hoverParts(contents: unknown): string[] {
  if (typeof contents === "string") return [contents];
  if (Array.isArray(contents)) return contents.flatMap(hoverParts);
  const record = asRecord(contents);
  if (!record || typeof record.value !== "string") return [];
  if (typeof record.language === "string" && record.language.length > 0) {
    return [`\`\`\`${sanitizeText(record.language, 80)}\n${record.value}\n\`\`\``];
  }
  return [record.value];
}

function normalizeHover(value: unknown, maxHoverChars: number): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const text = sanitizeText(hoverParts(record.contents).join("\n\n"), maxHoverChars);
  return text.length > 0 ? text : null;
}

function waitOptions(signal: AbortSignal | undefined, timeoutMs: number): ContentLengthJsonRpcWaitOptions {
  return { timeoutMs, ...(signal ? { signal } : {}) };
}

function defaultConnect(
  command: TypeScriptLanguageServerCommand,
  repoRoot: string
): ContentLengthJsonRpcConnection {
  const options: ContentLengthJsonRpcOptions = {
    command: command.command,
    args: command.args,
    cwd: repoRoot
  };
  return connectContentLengthJsonRpc(options);
}

async function waitForMatchingDiagnostics(
  subscription: ContentLengthJsonRpcNotificationSubscription,
  uri: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (let count = 0; count < MAX_DIAGNOSTIC_NOTIFICATIONS; count += 1) {
    const remaining = Math.max(1, deadline - Date.now());
    const notification = asRecord(await subscription.next(waitOptions(signal, remaining)));
    if (notification?.uri === uri) return notification;
  }
  throw new Error("LSP diagnostics exceeded the unmatched-notification cap.");
}

export function createTypeScriptLanguageServerAdapter(
  options: TypeScriptLanguageServerAdapterOptions = {}
): TypeScriptLanguageServerAdapter {
  const resolver = options.resolver ?? resolveTypeScriptLanguageServerCommand;
  const connect = options.connect ?? defaultConnect;
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
  const maxFileBytes = positiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
  const maxDiagnostics = positiveInteger(options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS, "maxDiagnostics");
  const maxLocations = positiveInteger(options.maxLocations ?? DEFAULT_MAX_LOCATIONS, "maxLocations");
  const maxHoverChars = positiveInteger(options.maxHoverChars ?? DEFAULT_MAX_HOVER_CHARS, "maxHoverChars");

  async function withDocument<T>(
    input: TypeScriptLanguageServerFileRequest,
    position: TypeScriptLanguageServerPosition | null,
    subscribeDiagnostics: boolean,
    action: (
      connection: ContentLengthJsonRpcConnection,
      document: PreparedDocument,
      subscription: ContentLengthJsonRpcNotificationSubscription | null
    ) => Promise<T>
  ): Promise<T> {
    const document = await prepareDocument(input, maxFileBytes);
    if (position) assertPosition(document.text, position.line, position.character);
    const command = await resolver(document.repoRoot);
    if (!command) throw new TypeScriptLanguageServerUnavailableError();

    const connection = connect(command, document.repoRoot);
    let subscription: ContentLengthJsonRpcNotificationSubscription | null = null;
    let primaryError: unknown = null;
    try {
      if (subscribeDiagnostics) {
        subscription = connection.subscribe("textDocument/publishDiagnostics");
      }
      await connection.request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "GuruHarness" },
          rootUri: pathToLspFileUri(document.repoRoot),
          capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
          workspaceFolders: [{ uri: pathToLspFileUri(document.repoRoot), name: basename(document.repoRoot) }]
        },
        waitOptions(input.signal, requestTimeoutMs)
      );
      connection.notify("initialized", {});
      connection.notify("textDocument/didOpen", {
        textDocument: {
          uri: document.uri,
          languageId: document.languageId,
          version: 1,
          text: document.text
        }
      });
      return await action(connection, document, subscription);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      subscription?.close();
      let cleanupError: unknown = null;
      try {
        await connection.request("shutdown", null, { timeoutMs: requestTimeoutMs });
      } catch (error) {
        cleanupError = error;
      }
      try {
        connection.notify("exit");
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await connection.close();
      } catch (error) {
        cleanupError ??= error;
      }
      if (primaryError === null && cleanupError !== null) {
        throw cleanupError;
      }
    }
  }

  function position(input: TypeScriptLanguageServerPositionRequest): TypeScriptLanguageServerPosition {
    return { line: input.line, character: input.character };
  }

  return {
    async status(repoRoot) {
      return (await resolver(resolve(repoRoot))) !== null;
    },

    diagnostics(input) {
      return withDocument(input, null, true, async (_connection, document, subscription) => {
        if (!subscription) throw new Error("LSP diagnostics subscription was not created.");
        const notification = await waitForMatchingDiagnostics(
          subscription,
          document.uri,
          requestTimeoutMs,
          input.signal
        );
        return normalizeDiagnostics(notification.diagnostics, maxDiagnostics);
      });
    },

    definition(input) {
      return withDocument(input, position(input), false, async (connection, document) => {
        const result = await connection.request(
          "textDocument/definition",
          { textDocument: { uri: document.uri }, position: position(input) },
          waitOptions(input.signal, requestTimeoutMs)
        );
        return await normalizeLocations(result, document.repoRoot, maxLocations);
      });
    },

    references(input) {
      return withDocument(input, position(input), false, async (connection, document) => {
        const result = await connection.request(
          "textDocument/references",
          {
            textDocument: { uri: document.uri },
            position: position(input),
            context: { includeDeclaration: true }
          },
          waitOptions(input.signal, requestTimeoutMs)
        );
        return await normalizeLocations(result, document.repoRoot, maxLocations);
      });
    },

    hover(input) {
      return withDocument(input, position(input), false, async (connection, document) => {
        const result = await connection.request(
          "textDocument/hover",
          { textDocument: { uri: document.uri }, position: position(input) },
          waitOptions(input.signal, requestTimeoutMs)
        );
        return normalizeHover(result, maxHoverChars);
      });
    }
  };
}
