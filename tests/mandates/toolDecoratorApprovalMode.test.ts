import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ToolDefinition } from '../../src/tools/registry.js';
import {
  getEffectiveApprovalMode,
  withToolApproval,
  type ToolApprovalMode
} from '../../src/mandates/toolDecoratorApprovalMode.js';

const inputSchema = z.object({
  command: z.string().optional(),
  path: z.string().optional()
});
const outputSchema = z.object({ ok: z.boolean() });

type TestTool = ToolDefinition<typeof inputSchema, typeof outputSchema>;

function makeTool(id = "safe"): TestTool {
  return {
    id,
    title: id,
    description: `${id} test tool`,
    inputSchema,
    outputSchema,
    execute: () => ({ ok: true })
  };
}

describe("tool decorator approval mode", () => {
  it("attaches the declared approvalMode metadata", () => {
    const tool = makeTool();
    const decorated = withToolApproval(tool, "never_require");

    expect(decorated).toBe(tool);
    expect(decorated.approvalMode).toBe("never_require");

    const modes: ToolApprovalMode[] = ["always_require", "never_require", "ask"];
    for (const mode of modes) {
      expect(withToolApproval(makeTool(), mode).approvalMode).toBe(mode);
    }
  });

  it("forces always_require for hard-limit calls", () => {
    const tool = withToolApproval(makeTool("bash"), "never_require");

    expect(getEffectiveApprovalMode(tool, { command: "rm -rf ./temporary" })).toBe("always_require");
  });

  it("keeps the declared mode for non-hard-limit calls", () => {
    const tool = withToolApproval(makeTool("safe"), "never_require");

    expect(getEffectiveApprovalMode(tool, {})).toBe("never_require");
  });
});
