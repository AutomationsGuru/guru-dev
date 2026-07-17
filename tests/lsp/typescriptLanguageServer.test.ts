import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContentLengthJsonRpcConnection,
  ContentLengthJsonRpcNotificationSubscription
} from "../../src/lsp/contentLengthJsonRpc.js";
import {
  createTypeScriptLanguageServerAdapter,
  languageIdForTypeScriptFile,
  lspFileUriToPath,
  pathToLspFileUri,
  resolveTypeScriptLanguageServerCommand,
  type TypeScriptLanguageServerCommand
} from "../../src/lsp/typescriptLanguageServer.js";

const COMMAND: TypeScriptLanguageServerCommand = {
  command: "typescript-language-server",
  args: ["--stdio"]
};

const temporaryDirectories: string[] = [];

function createRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "guruharness-lsp-"));
  temporaryDirectories.push(repoRoot);
  return repoRoot;
}

function writeRepoFile(repoRoot: string, relativePath: string, contents: string | Buffer): string {
  const path = join(repoRoot, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

interface FakeConnection extends ContentLengthJsonRpcConnection {
  readonly requests: Array<{ method: string; params: unknown }>;
  readonly notifications: Array<{ method: string; params: unknown }>;
  readonly closeMock: ReturnType<typeof vi.fn>;
}

function createConnection(options: {
  readonly request?: (method: string, params: unknown) => unknown | Promise<unknown>;
  readonly notifications?: readonly unknown[];
  readonly shutdownError?: Error;
} = {}): FakeConnection {
  const requests: FakeConnection["requests"] = [];
  const sentNotifications: FakeConnection["notifications"] = [];
  const queuedNotifications = [...(options.notifications ?? [])];
  const closeMock = vi.fn(async () => undefined);
  return {
    requests,
    notifications: sentNotifications,
    closeMock,
    async request(method, params) {
      requests.push({ method, params });
      if (method === "shutdown" && options.shutdownError) {
        throw options.shutdownError;
      }
      return options.request ? options.request(method, params) : null;
    },
    notify(method, params) {
      sentNotifications.push({ method, params });
    },
    subscribe(method) {
      expect(method).toBe("textDocument/publishDiagnostics");
      let closed = false;
      const subscription: ContentLengthJsonRpcNotificationSubscription = {
        async next() {
          if (closed) {
            throw new Error("closed");
          }
          if (queuedNotifications.length === 0) {
            throw new Error("notification queue exhausted");
          }
          return queuedNotifications.shift();
        },
        close() {
          closed = true;
        }
      };
      return subscription;
    },
    close: closeMock,
    stderrTail: () => "",
    exited: Promise.resolve(0)
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TypeScript language-server resolver", () => {
  it("prefers the repo-local executable, falls back to PATH, and never probes npx", async () => {
    const repoRoot = createRepo();
    const local = writeRepoFile(repoRoot, "node_modules/.bin/typescript-language-server", "#!/bin/sh\n");
    chmodSync(local, 0o755);
    const commandExists = vi.fn(() => true);

    await expect(resolveTypeScriptLanguageServerCommand(repoRoot, { platform: "linux", commandExists })).resolves.toEqual({
      command: local,
      args: ["--stdio"]
    });
    expect(commandExists).not.toHaveBeenCalled();

    rmSync(local);
    await expect(resolveTypeScriptLanguageServerCommand(repoRoot, { platform: "linux", commandExists })).resolves.toEqual(COMMAND);
    expect(commandExists).toHaveBeenCalledWith("typescript-language-server");
    expect(commandExists).not.toHaveBeenCalledWith("npx");

    commandExists.mockReturnValue(false);
    await expect(resolveTypeScriptLanguageServerCommand(repoRoot, { platform: "linux", commandExists })).resolves.toBeNull();
  });

  it("routes the repo-local Windows cmd form through the canonical spawn resolver", async () => {
    const repoRoot = createRepo();
    const local = writeRepoFile(repoRoot, "node_modules/.bin/typescript-language-server.cmd", "@echo off\r\n");
    const resolveSpawn = vi.fn(() => ({ executable: "C:\\node.exe", args: ["C:\\server.mjs", "--stdio"] }));

    await expect(
      resolveTypeScriptLanguageServerCommand(repoRoot, {
        platform: "win32",
        commandExists: () => false,
        resolveSpawn
      })
    ).resolves.toEqual({ command: "C:\\node.exe", args: ["C:\\server.mjs", "--stdio"] });
    expect(resolveSpawn).toHaveBeenCalledWith([local, "--stdio"]);
  });
});

describe("LSP file identity", () => {
  it("round-trips Linux paths with spaces and Unicode", () => {
    const path = "/repo/space here/naïve.ts";
    const uri = pathToLspFileUri(path, "linux");
    expect(uri).toBe("file:///repo/space%20here/na%C3%AFve.ts");
    expect(lspFileUriToPath(uri, "linux")).toBe(path);
  });

  it("round-trips Windows drive paths without treating the drive as a URI scheme", () => {
    const path = "C:\\repo space\\資料.tsx";
    const uri = pathToLspFileUri(path, "win32");
    expect(uri).toBe("file:///C:/repo%20space/%E8%B3%87%E6%96%99.tsx");
    expect(lspFileUriToPath(uri, "win32")).toBe(path);
  });

  it.each([
    ["file.ts", "typescript"],
    ["file.tsx", "typescriptreact"],
    ["file.js", "javascript"],
    ["file.jsx", "javascriptreact"]
  ])("maps %s to %s", (file, expected) => {
    expect(languageIdForTypeScriptFile(file)).toBe(expected);
  });
});

describe("TypeScript language-server lifecycle", () => {
  it("initializes, opens exact bounded UTF-8 text, and normalizes LocationLinks", async () => {
    const repoRoot = createRepo();
    const filePath = writeRepoFile(repoRoot, "src/space naïve.tsx", "export const value = 1;\n");
    const targetPath = writeRepoFile(repoRoot, "src/target.ts", "export const target = 1;\n");
    const connection = createConnection({
      request(method) {
        if (method === "initialize") return { capabilities: {} };
        if (method === "textDocument/definition") {
          return [
            {
              targetUri: pathToLspFileUri(targetPath),
              targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
              targetSelectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }
            },
            {
              uri: "file:///outside/library.d.ts",
              range: { start: { line: 4, character: 1 }, end: { line: 4, character: 5 } }
            }
          ];
        }
        return null;
      }
    });
    const adapter = createTypeScriptLanguageServerAdapter({
      resolver: async () => COMMAND,
      connect: () => connection
    });

    await expect(adapter.definition({ repoRoot, filePath, line: 0, character: 7 })).resolves.toEqual([
      {
        path: "src/target.ts",
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }
      },
      {
        uri: "file:///outside/library.d.ts",
        range: { start: { line: 4, character: 1 }, end: { line: 4, character: 5 } }
      }
    ]);

    expect(connection.requests.map(({ method }) => method)).toEqual([
      "initialize",
      "textDocument/definition",
      "shutdown"
    ]);
    expect(connection.requests[0]?.params).toMatchObject({ rootUri: pathToLspFileUri(realpathSync(repoRoot)) });
    expect(connection.notifications).toEqual([
      { method: "initialized", params: {} },
      {
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: pathToLspFileUri(filePath),
            languageId: "typescriptreact",
            version: 1,
            text: "export const value = 1;\n"
          }
        }
      },
      { method: "exit", params: undefined }
    ]);
    expect(connection.closeMock).toHaveBeenCalledOnce();
  });

  it("ignores diagnostics for other URIs and bounds/scrubs the matching payload", async () => {
    const repoRoot = createRepo();
    const filePath = writeRepoFile(repoRoot, "src/file.ts", "const value = 1;\n");
    const uri = pathToLspFileUri(filePath);
    const connection = createConnection({
      notifications: [
        { uri: "file:///other.ts", diagnostics: [{ message: "wrong" }] },
        {
          uri,
          diagnostics: Array.from({ length: 250 }, (_, index) => ({
            range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
            severity: 1,
            code: index,
            source: "ts\u0000server",
            message: `problem\u0000-${index}`
          }))
        }
      ]
    });
    const adapter = createTypeScriptLanguageServerAdapter({ resolver: async () => COMMAND, connect: () => connection });

    const diagnostics = await adapter.diagnostics({ repoRoot, filePath });
    expect(diagnostics).toHaveLength(200);
    expect(diagnostics[0]).toEqual({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      code: 0,
      source: "tsserver",
      message: "problem-0"
    });
    expect(connection.requests.map(({ method }) => method)).toEqual(["initialize", "shutdown"]);
  });

  it("bounds references and leaves out-of-root targets URI-labelled", async () => {
    const repoRoot = createRepo();
    const filePath = writeRepoFile(repoRoot, "src/file.ts", "const value = 1;\n");
    const connection = createConnection({
      request(method) {
        if (method === "textDocument/references") {
          return Array.from({ length: 250 }, (_, index) => ({
            uri: index === 0 ? "file:///outside/reference.ts" : pathToLspFileUri(filePath),
            range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } }
          }));
        }
        return null;
      }
    });
    const adapter = createTypeScriptLanguageServerAdapter({ resolver: async () => COMMAND, connect: () => connection });

    const references = await adapter.references({ repoRoot, filePath, line: 0, character: 1 });
    expect(references).toHaveLength(200);
    expect(references[0]).toEqual({
      uri: "file:///outside/reference.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    });
    expect(references[1]).toMatchObject({ path: "src/file.ts" });
  });

  it("normalizes MarkedString and MarkupContent hover forms with control-byte and character caps", async () => {
    const repoRoot = createRepo();
    const filePath = writeRepoFile(repoRoot, "src/file.ts", "const value = 1;\n");
    const connection = createConnection({
      request(method) {
        return method === "textDocument/hover"
          ? { contents: [{ language: "typescript", value: "const\u0000 value: number" }, { kind: "markdown", value: "x".repeat(20_000) }] }
          : null;
      }
    });
    const adapter = createTypeScriptLanguageServerAdapter({ resolver: async () => COMMAND, connect: () => connection });

    const hover = await adapter.hover({ repoRoot, filePath, line: 0, character: 2 });
    expect(hover).toContain("const value: number");
    expect(hover).not.toContain("\u0000");
    expect(hover?.length).toBeLessThanOrEqual(12_000);
  });

  it("rejects repo escapes, oversized files, and out-of-bounds positions before connecting", async () => {
    const repoRoot = createRepo();
    const outside = writeRepoFile(createRepo(), "outside.ts", "const outside = 1;\n");
    const oversized = writeRepoFile(repoRoot, "large.ts", Buffer.alloc(1024 * 1024 + 1, 0x61));
    const normal = writeRepoFile(repoRoot, "normal.ts", "const value = 1;\n");
    const connect = vi.fn(() => createConnection());
    const adapter = createTypeScriptLanguageServerAdapter({ resolver: async () => COMMAND, connect });

    await expect(adapter.diagnostics({ repoRoot, filePath: outside })).rejects.toThrow(/inside|contain/i);
    await expect(adapter.diagnostics({ repoRoot, filePath: oversized })).rejects.toThrow(/size|byte|large/i);
    await expect(adapter.definition({ repoRoot, filePath: normal, line: 9, character: 0 })).rejects.toThrow(/position|line/i);
    await expect(adapter.definition({ repoRoot, filePath: normal, line: 0, character: 99 })).rejects.toThrow(/position|character/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it("reports availability without connecting and always shuts down, exits, and closes after request failure", async () => {
    const repoRoot = createRepo();
    const filePath = writeRepoFile(repoRoot, "file.ts", "const value = 1;\n");
    const connection = createConnection({
      request(method) {
        if (method === "textDocument/definition") throw new Error("request failed");
        return null;
      },
      shutdownError: new Error("shutdown failed")
    });
    const resolver = vi.fn(async () => COMMAND);
    const connect = vi.fn(() => connection);
    const adapter = createTypeScriptLanguageServerAdapter({ resolver, connect });

    await expect(adapter.status(repoRoot)).resolves.toBe(true);
    expect(connect).not.toHaveBeenCalled();
    await expect(adapter.definition({ repoRoot, filePath, line: 0, character: 0 })).rejects.toThrow("request failed");
    expect(connection.requests.map(({ method }) => method)).toContain("shutdown");
    expect(connection.notifications.at(-1)).toEqual({ method: "exit", params: undefined });
    expect(connection.closeMock).toHaveBeenCalledOnce();
  });
});
