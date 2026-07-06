import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { sanitizeToolOutput } from "../../src/safety/outputSanitizer.js";
import { clearRegisteredSecretValues, registerSecretValue } from "../../src/safety/secretSafety.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

afterEach(() => {
  clearRegisteredSecretValues();
});

describe("sanitizeToolOutput — deep-walk shape+value scrub", () => {
  it("scrubs token shapes in nested strings, arrays, and objects", () => {
    const dirty = {
      stdout: "key is sk-abcdefghijklmnop1234 done",
      nested: { lines: ["AKIA1234567890ABCDEF appears here", "clean line"] },
      count: 3
    };
    const clean = sanitizeToolOutput(dirty) as typeof dirty;
    expect(clean.stdout).not.toContain("sk-abcdefghijklmnop1234");
    expect(clean.nested.lines[0]).not.toContain("AKIA1234567890ABCDEF");
    expect(clean.nested.lines[1]).toBe("clean line");
    expect(clean.count).toBe(3);
  });

  it("scrubs REGISTERED values even when they match no shape", () => {
    registerSecretValue("hunter2hunter2");
    const clean = sanitizeToolOutput({ note: "password was hunter2hunter2 ok" }) as { note: string };
    expect(clean.note).not.toContain("hunter2hunter2");
  });

  it("returns the SAME reference when nothing needed scrubbing (no churn)", () => {
    const clean = { a: "hello", b: [1, 2], c: { d: "world" } };
    expect(sanitizeToolOutput(clean)).toBe(clean);
  });

  it("newly added shapes (Google API key, GitLab PAT, npm token) are covered", () => {
    const clean = sanitizeToolOutput({
      a: `AIza${"A".repeat(35)}`,
      b: `glpat-${"x".repeat(20)}`,
      c: `npm_${"a".repeat(36)}`
    }) as Record<string, string>;
    expect(clean.a).toContain("redacted");
    expect(clean.b).toContain("redacted");
    expect(clean.c).toContain("redacted");
  });
});

describe("THE CHOKE POINT: every tool result passes the sanitizer by construction", () => {
  it("a tool that reads a .env-style secret cannot leak it — even though the tool itself did", async () => {
    const registry = createToolRegistry([
      {
        id: "leaky",
        title: "Leaky tool",
        description: "Returns raw secret-bearing text (simulates cat .env).",
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ contents: z.string() }).strict(),
        execute: () => ({ contents: "AWS_KEY=AKIA1234567890ABCDEF\nOPENAI=sk-abcdefghijklmnop1234" })
      }
    ]);
    const observation = await executeRegisteredTool(registry, "leaky", {});
    expect(observation.status).toBe("succeeded");
    const output = observation.output as { contents: string };
    expect(output.contents).not.toContain("AKIA1234567890ABCDEF");
    expect(output.contents).not.toContain("sk-abcdefghijklmnop1234");
    expect(output.contents).toContain("redacted");
  });

  it("failure messages are scrubbed too", async () => {
    registerSecretValue("supersecretvalue99");
    const registry = createToolRegistry([
      {
        id: "thrower",
        title: "Throwing tool",
        description: "Throws with a secret in the message.",
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({}).strict(),
        execute: () => {
          throw new Error("connect failed using supersecretvalue99");
        }
      }
    ]);
    const observation = await executeRegisteredTool(registry, "thrower", {});
    expect(observation.status).toBe("failed");
    expect(observation.error ?? "").not.toContain("supersecretvalue99");
  });
});
