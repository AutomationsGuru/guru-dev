import { describe, expect, it } from "vitest";

import { z } from "zod";

import {
  previewFromInput,
  previewToolEffect,
  SpeculativePreviewInputSchema,
  SpeculativePreviewOutputSchema
} from '../../src/tools/speculativeToolPreview.js';
import { createToolRegistry, type ToolDefinition } from '../../src/tools/registry.js';

/**
 * A tiny in-memory filesystem stand-in. Preview must leave it byte-identical
 * and must never invoke the tool's execute (which is what would mutate it).
 */
function createMockFs(initial: Record<string, string> = {}): {
  files: Record<string, string>;
  write: (path: string, contents: string) => void;
} {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    write(path, contents) {
      files[path] = contents;
    }
  };
}

/** A fake write tool that WOULD mutate the mock fs if its execute ran. */
function createFakeWriteTool(fs: { write: (path: string, contents: string) => void }): ToolDefinition {
  return {
    id: "write",
    title: "Write file",
    description: "Writes a file.",
    effect: "mutating",
    inputSchema: z.object({ path: z.string(), contents: z.string() }).strict(),
    outputSchema: z.object({ applied: z.boolean() }),
    async execute(input: { path: string; contents: string }) {
      fs.write(input.path, input.contents);
      return { applied: true };
    }
  };
}

/** A fake read-only tool. */
function createFakeReadTool(): ToolDefinition {
  return {
    id: "read",
    title: "Read file",
    description: "Reads a file.",
    effect: "read-only",
    inputSchema: z.object({ path: z.string() }).strict(),
    outputSchema: z.object({ bytes: z.number() }),
    async execute() {
      return { bytes: 0 };
    }
  };
}

describe("speculative tool preview", () => {
  it("describes a known mutating tool's effect from args alone", () => {
    const fs = createMockFs();
    const tool = createFakeWriteTool(fs);
    const out = previewToolEffect(tool, "write", { path: "a.txt", contents: "hello" });

    expect(out.recognized).toBe(true);
    expect(out.effect).toBe("mutating");
    expect(out.wouldExecute).toBe(false);
    expect(out.description).toMatch(/Would write file at a\.txt/);
  });

  it("does NOT mutate the mock fs and does NOT call execute", () => {
    const fs = createMockFs({ "existing.txt": "keep-me" });
    let executeCalled = false;
    const tool: ToolDefinition = {
      id: "write",
      title: "Write file",
      description: "Writes a file.",
      effect: "mutating",
      inputSchema: z.object({ path: z.string(), contents: z.string() }).strict(),
      outputSchema: z.object({ applied: z.boolean() }),
      async execute() {
        executeCalled = true;
        fs.write("existing.txt", "overwritten");
        return { applied: true };
      }
    };

    previewToolEffect(tool, "write", { path: "existing.txt", contents: "should never land" });

    expect(executeCalled).toBe(false);
    expect(fs.files["existing.txt"]).toBe("keep-me");
    expect(Object.keys(fs.files)).toEqual(["existing.txt"]);
  });

  it("reports an unknown tool without describing an effect", () => {
    const fs = createMockFs();
    const registry = createToolRegistry([createFakeReadTool()]);
    const out = previewToolEffect(registry, "nope", {});

    expect(out.recognized).toBe(false);
    expect(out.effect).toBe("unknown");
    expect(out.wouldExecute).toBe(false);
    expect(out.description).toMatch(/not registered/);
    expect(fs.files).toEqual({});
  });

  it("falls back to declared effect + static description for unmodeled tools", () => {
    const tool: ToolDefinition = {
      id: "exotic",
      title: "Exotic",
      description: "Does something exotic.",
      effect: "read-only",
      inputSchema: z.object({ x: z.number() }).strict(),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute() {
        return { ok: true };
      }
    };
    const out = previewToolEffect(tool, "exotic", { x: 1 });

    expect(out.recognized).toBe(true);
    expect(out.effect).toBe("read-only");
    expect(out.description).toMatch(/Does something exotic/);
    expect(out.notes).toEqual([]);
  });

  it("flags args that would fail the tool input schema, without executing", () => {
    const fs = createMockFs();
    const tool = createFakeWriteTool(fs);
    const out = previewToolEffect(tool, "write", { path: "a.txt" /* missing contents */ });

    expect(out.recognized).toBe(true);
    expect(out.notes.some((note) => /input schema/.test(note))).toBe(true);
    expect(fs.files).toEqual({});
  });

  it("validates against its own input/output schemas", () => {
    const input = { toolName: "write", args: { path: "a.txt", contents: "x" } };
    expect(SpeculativePreviewInputSchema.safeParse(input).success).toBe(true);
    expect(SpeculativePreviewInputSchema.safeParse({ toolName: "", args: {} }).success).toBe(false);

    const out = previewFromInput(undefined, input);
    expect(SpeculativePreviewOutputSchema.safeParse(out).success).toBe(true);
  });

  it("describes bash/shell as mutating and opaque", () => {
    const out = previewToolEffect(undefined, "bash", { command: "rm -rf /tmp/x" });
    // Unknown to a registry, but the canned description still fires for known ids.
    const out2 = previewToolEffect(
      {
        id: "bash",
        title: "Bash",
        description: "Run shell.",
        effect: "mutating",
        inputSchema: z.object({ command: z.string() }),
        outputSchema: z.object({ stdout: z.string() }),
        async execute() {
          return { stdout: "" };
        }
      },
      "bash",
      { command: "rm -rf /tmp/x" }
    );
    expect(out2.description).toMatch(/execute a shell command/i);
    expect(out2.effect).toBe("mutating");
    expect(out.recognized).toBe(false);
  });
});
