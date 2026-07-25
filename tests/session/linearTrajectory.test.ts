import { describe, expect, it } from "vitest";

import { LinearTrajectory } from '../../src/session/linearTrajectory.js';
import { LinearTrajectoryMessageSchema, LinearTrajectorySchema } from '../../src/session/linearTrajectorySchema.js';

describe("LinearTrajectory", () => {
  it("appends role/content/tool records in the exact order the model sees", () => {
    const trajectory = new LinearTrajectory();

    trajectory.append({ role: "system", content: "Follow the repository rules." });
    trajectory.append({ role: "user", content: "Inspect src/session." });
    trajectory.append({
      role: "assistant",
      content: "I will inspect it.",
      tool: { name: "read", input: { path: "src/session" }, output: { entries: ["agentSession.ts"] } }
    });

    expect(trajectory.asModelMessages()).toEqual([
      { role: "system", content: "Follow the repository rules." },
      { role: "user", content: "Inspect src/session." },
      {
        role: "assistant",
        content: "I will inspect it.",
        tool: { name: "read", input: { path: "src/session" }, output: { entries: ["agentSession.ts"] } }
      }
    ]);
  });

  it("preserves prior records when callers mutate input or an exported snapshot", () => {
    const input = {
      role: "assistant" as const,
      content: "Reading the file.",
      tool: { name: "read", input: { path: "src/session/agentSession.ts" } }
    };
    const trajectory = new LinearTrajectory();

    trajectory.append(input);
    input.content = "Rewritten caller content.";
    input.tool.input.path = "changed-by-caller.ts";

    const exported = trajectory.asModelMessages();
    const first = exported[0];
    if (first?.tool?.input && typeof first.tool.input === "object") {
      (first.tool.input as { path: string }).path = "changed-through-export.ts";
    }

    expect(trajectory.asModelMessages()).toEqual([
      {
        role: "assistant",
        content: "Reading the file.",
        tool: { name: "read", input: { path: "src/session/agentSession.ts" } }
      }
    ]);
  });

  it("exports a strict JSON-ready trajectory shape", () => {
    const trajectory = new LinearTrajectory();
    trajectory.append({ role: "user", content: "Run the focused test." });

    const exported = trajectory.asModelMessages();

    expect(LinearTrajectorySchema.parse(exported)).toEqual(exported);
    expect(LinearTrajectoryMessageSchema.safeParse({ role: "user", content: "x", extra: true }).success).toBe(false);
    expect(
      LinearTrajectoryMessageSchema.safeParse({
        role: "assistant",
        content: "x",
        tool: { name: "read", input: undefined }
      }).success
    ).toBe(false);
  });
});
