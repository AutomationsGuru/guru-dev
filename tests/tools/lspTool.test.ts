import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  TypeScriptLanguageServerAdapter,
  TypeScriptLanguageServerAdapterOptions,
  TypeScriptLanguageServerDiagnostic,
  TypeScriptLanguageServerLocation
} from "../../src/lsp/typescriptLanguageServer.js";
import { LspToolInputSchema, createLspTool, type LspToolInput, type LspToolOutput } from "../../src/tools/builtins/lspTool.js";
import { createBaseTools } from "../../src/tools/builtins/baseToolFactory.js";

function fakeLocation(path: string, line: number): TypeScriptLanguageServerLocation {
  return {
    path,
    range: { start: { line, character: 0 }, end: { line, character: 10 } }
  };
}

function fakeDiagnostic(message: string): TypeScriptLanguageServerDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
    severity: 1,
    message
  };
}

// Build a disposable temp repo with one .ts file for path-containment tests.
async function makeTempRepo(filename = "index.ts"): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "guruharness-lsp-tool-"));
  const srcDir = join(root, "src");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, filename), 'const x: number = 1;\n', "utf8");
  return root;
}

function statusAdapter(available: boolean): TypeScriptLanguageServerAdapter {
  return {
    status: vi.fn(async () => available),
    diagnostics: vi.fn(async () => []),
    definition: vi.fn(async () => []),
    references: vi.fn(async () => []),
    hover: vi.fn(async () => null)
  };
}

describe("lspTool schema validation", () => {
  it("accepts a valid status input", () => {
    expect(() => LspToolInputSchema.parse({ repoRoot: "/repo", action: "status" })).not.toThrow();
  });

  it("accepts a valid diagnostics input with path", () => {
    expect(() =>
      LspToolInputSchema.parse({ repoRoot: "/repo", action: "diagnostics", path: "src/index.ts" })
    ).not.toThrow();
  });

  it("accepts a valid definition input with path and position", () => {
    expect(() =>
      LspToolInputSchema.parse({ repoRoot: "/repo", action: "definition", path: "src/index.ts", line: 0, character: 5 })
    ).not.toThrow();
  });

  it("rejects diagnostics without a path", () => {
    const result = LspToolInputSchema.safeParse({ repoRoot: "/repo", action: "diagnostics" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("path"))).toBe(true);
    }
  });

  it("rejects definition without line", () => {
    const result = LspToolInputSchema.safeParse({ repoRoot: "/repo", action: "definition", path: "x.ts" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("line"))).toBe(true);
    }
  });

  it("rejects definition without character", () => {
    const result = LspToolInputSchema.safeParse({ repoRoot: "/repo", action: "definition", path: "x.ts", line: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("character"))).toBe(true);
    }
  });

  it("rejects references without line and character", () => {
    const result = LspToolInputSchema.safeParse({ repoRoot: "/repo", action: "references", path: "x.ts" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("line"))).toBe(true);
      expect(result.error.issues.some((i) => i.path.includes("character"))).toBe(true);
    }
  });

  it("rejects hover without line and character", () => {
    const result = LspToolInputSchema.safeParse({ repoRoot: "/repo", action: "hover", path: "x.ts" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("line"))).toBe(true);
      expect(result.error.issues.some((i) => i.path.includes("character"))).toBe(true);
    }
  });

  it("rejects an invalid action", () => {
    const result = LspToolInputSchema.safeParse({ repoRoot: "/repo", action: "rename" });
    expect(result.success).toBe(false);
  });

  it("rejects extra unknown properties (strict)", () => {
    const result = LspToolInputSchema.safeParse({
      repoRoot: "/repo",
      action: "status",
      command: "evil"
    });
    expect(result.success).toBe(false);
  });
});

describe("lspTool status", () => {
  it("reports available when the resolver finds a server", async () => {
    const adapter = statusAdapter(true);
    const tool = createLspTool({ adapter });
    const output = await tool.execute({ repoRoot: "/repo", action: "status" }, {});
    expect(output.status).toBe("available");
    expect(adapter.status).toHaveBeenCalledOnce();
  });

  it("reports unavailable when the resolver finds no server", async () => {
    const adapter = statusAdapter(false);
    const tool = createLspTool({ adapter });
    const output = await tool.execute({ repoRoot: "/repo", action: "status" }, {});
    expect(output.status).toBe("unavailable");
    expect(output.summary).toMatch(/typescript-language-server/i);
    expect(adapter.status).toHaveBeenCalledOnce();
  });

  it("reports unavailable on a probing error without crashing", async () => {
    const adapter: TypeScriptLanguageServerAdapter = {
      ...statusAdapter(false),
      status: vi.fn(async () => Promise.reject(new Error("probe failed")))
    };
    const tool = createLspTool({ adapter });
    const output = await tool.execute({ repoRoot: "/repo", action: "status" }, {});
    expect(output.status).toBe("unavailable");
    expect(output.summary).toMatch(/probe failed/);
  });
});

describe("lspTool path containment", () => {
  it("blocks a repo escape via .. traversal before starting a server", async () => {
    const root = await makeTempRepo();
    try {
      const adapter = statusAdapter(true);
      const tool = createLspTool({ adapter });
      const output = (await tool.execute({
        repoRoot: root,
        action: "diagnostics",
        path: "../outside.ts"
      }, {})) as LspToolOutput & { status: string };
      expect(output.status).toBe("failed");
      expect(output.summary).toMatch(/contained|escape|repository/i);
      // Adapter must never have been touched.
      expect(adapter.diagnostics).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a missing file before starting a server", async () => {
    const root = await makeTempRepo();
    try {
      const adapter = statusAdapter(true);
      const tool = createLspTool({ adapter });
      const output = (await tool.execute({
        repoRoot: root,
        action: "diagnostics",
        path: "src/missing.ts"
      }, {})) as LspToolOutput & { status: string };
      expect(output.status).toBe("failed");
      expect(output.summary).toMatch(/does not exist/);
      expect(adapter.diagnostics).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a directory target before starting a server", async () => {
    const root = await makeTempRepo();
    try {
      const adapter = statusAdapter(true);
      const tool = createLspTool({ adapter });
      const output = (await tool.execute({
        repoRoot: root,
        action: "diagnostics",
        path: "src"
      }, {})) as LspToolOutput & { status: string };
      expect(output.status).toBe("failed");
      expect(output.summary).toMatch(/regular file/);
      expect(adapter.diagnostics).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks an absolute escape path", async () => {
    const root = await makeTempRepo();
    try {
      const adapter = statusAdapter(true);
      const tool = createLspTool({ adapter });
      const output = (await tool.execute({
        repoRoot: root,
        action: "diagnostics",
        path: "/etc/passwd"
      }, {})) as LspToolOutput & { status: string };
      expect(output.status).toBe("failed");
      expect(output.summary).toMatch(/contained|escape|repository/i);
      expect(adapter.diagnostics).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a file that exceeds the size cap", async () => {
    const root = await makeTempRepo();
    try {
      // Write a file larger than 1 MB
      await writeFile(join(root, "src", "huge.ts"), "x".repeat(2 * 1024 * 1024), "utf8");
      const adapter = statusAdapter(true);
      const tool = createLspTool({ adapter });
      const output = (await tool.execute({
        repoRoot: root,
        action: "diagnostics",
        path: "src/huge.ts"
      }, {})) as LspToolOutput & { status: string };
      expect(output.status).toBe("failed");
      expect(output.summary).toMatch(/size cap/);
      expect(adapter.diagnostics).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("lspTool canonical adapter dispatch", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTempRepo();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("dispatches diagnostics to the adapter diagnostics method only", async () => {
    const adapter = statusAdapter(true);
    const spy = vi.spyOn(adapter, "diagnostics");
    const tool = createLspTool({ adapter });
    await tool.execute({ repoRoot: root, action: "diagnostics", path: "src/index.ts" }, {});
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: root, filePath: expect.stringContaining("index.ts") }));
  });

  it("dispatches definition to the adapter definition method only", async () => {
    const adapter = statusAdapter(true);
    adapter.definition = vi.fn(async () => [fakeLocation("src/index.ts", 0)]);
    const spy = vi.spyOn(adapter, "definition");
    const tool = createLspTool({ adapter });
    await tool.execute({ repoRoot: root, action: "definition", path: "src/index.ts", line: 0, character: 5 }, {});
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: root, filePath: expect.stringContaining("index.ts"), line: 0, character: 5 })
    );
  });

  it("dispatches references to the adapter references method only", async () => {
    const adapter = statusAdapter(true);
    adapter.references = vi.fn(async () => [fakeLocation("src/index.ts", 0)]);
    const spy = vi.spyOn(adapter, "references");
    const tool = createLspTool({ adapter });
    await tool.execute({ repoRoot: root, action: "references", path: "src/index.ts", line: 0, character: 5 }, {});
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: root, filePath: expect.stringContaining("index.ts"), line: 0, character: 5 })
    );
  });

  it("dispatches hover to the adapter hover method only", async () => {
    const adapter = statusAdapter(true);
    adapter.hover = vi.fn(async () => "const x: number");
    const spy = vi.spyOn(adapter, "hover");
    const tool = createLspTool({ adapter });
    await tool.execute({ repoRoot: root, action: "hover", path: "src/index.ts", line: 0, character: 5 }, {});
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: root, filePath: expect.stringContaining("index.ts"), line: 0, character: 5 })
    );
  });

  it("returns completed diagnostics with parsed results", async () => {
    const adapter = statusAdapter(true);
    adapter.diagnostics = vi.fn(async () => [fakeDiagnostic("TS2322: type error")]);
    const tool = createLspTool({ adapter });
    const output = (await tool.execute({
      repoRoot: root,
      action: "diagnostics",
      path: "src/index.ts"
    }, {})) as LspToolOutput & { status: string };
    expect(output.status).toBe("completed");
    if (output.status === "completed" && "diagnostics" in output) {
      expect(output.diagnostics).toHaveLength(1);
      expect(output.diagnostics[0]?.message).toBe("TS2322: type error");
    }
  });

  it("returns completed definition with location results", async () => {
    const adapter = statusAdapter(true);
    adapter.definition = vi.fn(async () => [fakeLocation("src/index.ts", 1)]);
    const tool = createLspTool({ adapter });
    const output = (await tool.execute({
      repoRoot: root,
      action: "definition",
      path: "src/index.ts",
      line: 0,
      character: 5
    }, {})) as LspToolOutput & { status: string };
    expect(output.status).toBe("completed");
    if (output.status === "completed" && "locations" in output) {
      expect(output.locations).toHaveLength(1);
    }
  });

  it("returns completed hover with text", async () => {
    const adapter = statusAdapter(true);
    adapter.hover = vi.fn(async () => "const x: number");
    const tool = createLspTool({ adapter });
    const output = (await tool.execute({
      repoRoot: root,
      action: "hover",
      path: "src/index.ts",
      line: 0,
      character: 5
    }, {})) as LspToolOutput & { status: string };
    expect(output.status).toBe("completed");
    if (output.status === "completed" && "hover" in output) {
      expect(output.hover).toBe("const x: number");
    }
  });

  it("returns failed on adapter error without crashing", async () => {
    const adapter = statusAdapter(true);
    adapter.diagnostics = vi.fn(async () => Promise.reject(new Error("server crash")));
    const tool = createLspTool({ adapter });
    const output = (await tool.execute({
      repoRoot: root,
      action: "diagnostics",
      path: "src/index.ts"
    }, {})) as LspToolOutput & { status: string };
    expect(output.status).toBe("failed");
    expect(output.summary).toMatch(/server crash/);
  });
});

describe("lspTool in base registry", () => {
  it("includes exactly one lsp tool by default", () => {
    const tools = createBaseTools();
    const lspTools = tools.filter((t) => t.id === "lsp");
    expect(lspTools).toHaveLength(1);
    expect(lspTools[0]?.title).toBe("LSP code intelligence");
    // It must be classified as read-only — not as exec.
    expect(lspTools[0]?.description).toMatch(/read-only/i);
  });
});
