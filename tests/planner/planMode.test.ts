import { z } from "zod";

import {
  createCertifiedPlanModePolicy,
  createPlanModePolicy,
  executePlanModeTool,
  parsePlanModeDraft,
  PLAN_MODE_DEFAULT_TOOL_IDS,
  PlanModeDraftSchema
} from "../../src/planner/planMode.js";
import { createToolRegistry, type ToolDefinition } from "../../src/tools/registry.js";

describe("PlanModeDraftSchema", () => {
  it("accepts a bounded read-only plan draft", () => {
    const draft = PlanModeDraftSchema.parse({
      objective: "Inspect the repository before proposing a change.",
      assumptions: ["The working tree is available locally."],
      steps: [{ order: 1, description: "Inspect the affected source files." }],
      affectedPaths: ["src/planner/planMode.ts"],
      validation: ["Run the focused planner tests."],
      unresolvedQuestions: []
    });

    expect(draft.steps[0]?.order).toBe(1);
  });

  it("rejects an empty step list", () => {
    const result = PlanModeDraftSchema.safeParse({
      objective: "Inspect the repository.",
      assumptions: [],
      steps: [],
      affectedPaths: [],
      validation: ["Run focused tests."],
      unresolvedQuestions: []
    });

    expect(result.success).toBe(false);
  });

  it("rejects steps whose explicit order is not sequential", () => {
    const result = PlanModeDraftSchema.safeParse({
      objective: "Inspect the repository.",
      assumptions: [],
      steps: [{ order: 2, description: "Inspect source files." }],
      affectedPaths: [],
      validation: ["Run focused tests."],
      unresolvedQuestions: []
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("order must match its one-based position");
  });

  it.each(["../secrets.env", "src/planner/../secrets.env", "src\\planner\\..\\secrets.env"])(
    "rejects a traversal-bearing affected path: %s",
    (affectedPath) => {
      const result = PlanModeDraftSchema.safeParse({
        objective: "Inspect the repository.",
        assumptions: [],
        steps: [{ order: 1, description: "Inspect source files." }],
        affectedPaths: [affectedPath],
        validation: ["Run focused tests."],
        unresolvedQuestions: []
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("path traversal");
    }
  );

  it("rejects a NUL-bearing affected path", () => {
    const result = PlanModeDraftSchema.safeParse({
      objective: "Inspect the repository.",
      assumptions: [],
      steps: [{ order: 1, description: "Inspect source files." }],
      affectedPaths: ["src/planner/planMode.ts\0ignored"],
      validation: ["Run focused tests."],
      unresolvedQuestions: []
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("NUL");
  });

  it("rejects an oversized objective", () => {
    const result = PlanModeDraftSchema.safeParse({
      objective: "x".repeat(4_001),
      assumptions: [],
      steps: [{ order: 1, description: "Inspect source files." }],
      affectedPaths: [],
      validation: ["Run focused tests."],
      unresolvedQuestions: []
    });

    expect(result.success).toBe(false);
  });

  it("rejects a draft that exceeds the aggregate size bound", () => {
    const result = PlanModeDraftSchema.safeParse({
      objective: "Inspect the repository.",
      assumptions: Array.from({ length: 25 }, (_, index) => `${index}-${"x".repeat(995)}`),
      steps: [{ order: 1, description: "Inspect source files." }],
      affectedPaths: [],
      validation: ["Run focused tests."],
      unresolvedQuestions: []
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.at(-1)?.message).toContain("serialized size");
  });
});

describe("parsePlanModeDraft", () => {
  it("returns a legible failure result for an invalid draft", () => {
    const result = parsePlanModeDraft({
      objective: "",
      assumptions: [],
      steps: [],
      affectedPaths: [],
      validation: [],
      unresolvedQuestions: []
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain("objective");
    }
  });
});

describe("createPlanModePolicy", () => {
  it("exposes only exact allowlisted definitions through an immutable view", () => {
    const readTool = createEchoTool("repo.read");
    const writeTool = createEchoTool("repo.write");
    const policy = createPlanModePolicy(createToolRegistry([writeTool, readTool]), ["repo.read"]);
    const definitions = policy.listTools();

    expect(definitions).toEqual([readTool]);
    expect(policy.getTool("repo.read")).toBe(readTool);
    expect(policy.getTool("repo.write")).toBeUndefined();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(definitions)).toBe(true);
    expect("register" in policy).toBe(false);
    expect(() => (definitions as ToolDefinition[]).push(writeTool)).toThrow();
  });

  it("rejects an empty read-only allowlist", () => {
    expect(() => createPlanModePolicy(createToolRegistry([createEchoTool("repo.read")]), [])).toThrow(
      "at least one"
    );
  });

  it("rejects duplicate read-only tool ids", () => {
    const registry = createToolRegistry([createEchoTool("repo.read")]);

    expect(() => createPlanModePolicy(registry, ["repo.read", "repo.read"])).toThrow("Duplicate");
  });

  it("rejects an unknown read-only tool id", () => {
    expect(() => createPlanModePolicy(createToolRegistry([createEchoTool("repo.read")]), ["missing.tool"])).toThrow(
      "not registered"
    );
  });
});

describe("executePlanModeTool", () => {
  it("preserves registry observations, abort forwarding, and output sanitization", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const tool: ToolDefinition = {
      ...createEchoTool("repo.read"),
      execute(input, context) {
        receivedSignal = context.signal;

        return input;
      }
    };
    const policy = createPlanModePolicy(createToolRegistry([tool]), ["repo.read"]);

    const observation = await executePlanModeTool(
      policy,
      "repo.read",
      { message: "sk-abcdefghijklmnop1234" },
      { signal: controller.signal }
    );

    expect(receivedSignal).toBe(controller.signal);
    expect(observation).toMatchObject({ toolId: "repo.read", status: "succeeded" });
    expect(JSON.stringify(observation.output)).not.toContain("sk-abcdefghijklmnop1234");
  });

  it("rejects a registered tool that is not allowlisted before execution", async () => {
    let writeCalled = false;
    const writeTool: ToolDefinition = {
      ...createEchoTool("repo.write"),
      execute(input) {
        writeCalled = true;

        return input;
      }
    };
    const policy = createPlanModePolicy(createToolRegistry([createEchoTool("repo.read"), writeTool]), ["repo.read"]);

    await expect(executePlanModeTool(policy, "repo.write", { message: "blocked" })).rejects.toThrow("not allowlisted");
    expect(writeCalled).toBe(false);
  });

  it("rejects an unknown tool id legibly", async () => {
    const policy = createPlanModePolicy(createToolRegistry([createEchoTool("repo.read")]), ["repo.read"]);

    await expect(executePlanModeTool(policy, "missing.tool", {})).rejects.toThrow("not registered");
  });

  it("preserves registry input validation without invoking the tool", async () => {
    let toolCalled = false;
    const tool: ToolDefinition = {
      ...createEchoTool("repo.read"),
      execute(input) {
        toolCalled = true;

        return input;
      }
    };
    const policy = createPlanModePolicy(createToolRegistry([tool]), ["repo.read"]);

    const observation = await executePlanModeTool(policy, "repo.read", { message: 42 });

    expect(observation.status).toBe("failed");
    expect(observation.error).toContain("Invalid input at message");
    expect(toolCalled).toBe(false);
  });
});

describe("PLAN_MODE_DEFAULT_TOOL_IDS", () => {
  it("exposes the four read-only exploration tools in registry order and is frozen", () => {
    expect(PLAN_MODE_DEFAULT_TOOL_IDS).toEqual(["glob", "grep", "ls", "read"]);
    expect(Object.isFrozen(PLAN_MODE_DEFAULT_TOOL_IDS)).toBe(true);
  });
});

describe("createCertifiedPlanModePolicy", () => {
  it("certifies exactly the read-only-marked tools in registry order through a frozen view", () => {
    const registry = createToolRegistry([
      createToolWithEffect("read", "read-only"),
      createToolWithEffect("grep", "read-only"),
      createToolWithEffect("glob", "read-only"),
      createToolWithEffect("ls", "read-only")
    ]);
    const policy = createCertifiedPlanModePolicy(registry);

    expect(policy.listTools().map((tool) => tool.id)).toEqual(["glob", "grep", "ls", "read"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.listTools())).toBe(true);
    expect("register" in policy).toBe(false);
  });

  it("rejects unmarked and explicitly mutating definitions even when caller-allowlisted", () => {
    const registry = createToolRegistry([
      createToolWithEffect("read", "read-only"),
      createToolWithEffect("sneaky.unmarked", undefined),
      createToolWithEffect("sneaky.mutating", "mutating")
    ]);
    const policy = createCertifiedPlanModePolicy(registry, ["read", "sneaky.unmarked", "sneaky.mutating"]);

    expect(policy.listTools().map((tool) => tool.id)).toEqual(["read"]);
    expect(policy.getTool("sneaky.unmarked")).toBeUndefined();
    expect(policy.getTool("sneaky.mutating")).toBeUndefined();
  });

  it("snapshots the executor so a later reassignment on the source definition cannot replace it", async () => {
    let originalCalls = 0;
    const readTool: ToolDefinition = {
      ...createToolWithEffect("read", "read-only"),
      execute(input) {
        originalCalls += 1;

        return input;
      }
    };
    const registry = createToolRegistry([readTool]);
    const policy = createCertifiedPlanModePolicy(registry);

    let spyCalls = 0;
    // Mutate the ORIGINAL definition's executor after certification.
    readTool.execute = () => {
      spyCalls += 1;

      return { message: "spy" };
    };

    const observation = await executePlanModeTool(policy, "read", { message: "x" });

    expect(observation.status).toBe("succeeded");
    expect(originalCalls).toBe(1);
    expect(spyCalls).toBe(0);
  });

  it("freezes each certified definition so its executor cannot be replaced through the policy view", () => {
    const registry = createToolRegistry([createToolWithEffect("read", "read-only")]);
    const policy = createCertifiedPlanModePolicy(registry);
    const certified = policy.listTools()[0];

    expect(certified).toBeDefined();
    if (!certified) {
      return;
    }
    expect(Object.isFrozen(certified)).toBe(true);
  });

  it("is not enlarged by tools registered on the source registry after certification", () => {
    const registry = createToolRegistry([
      createToolWithEffect("read", "read-only"),
      createToolWithEffect("grep", "read-only")
    ]);
    const policy = createCertifiedPlanModePolicy(registry, ["read", "grep"]);

    registry.register(createToolWithEffect("ls", "read-only"));
    registry.register(createToolWithEffect("glob", "read-only"));

    expect(policy.listTools().map((tool) => tool.id)).toEqual(["grep", "read"]);
  });

  it("de-duplicates repeated candidate ids", () => {
    const registry = createToolRegistry([createToolWithEffect("read", "read-only")]);
    const policy = createCertifiedPlanModePolicy(registry, ["read", "read", "read"]);

    expect(policy.listTools().map((tool) => tool.id)).toEqual(["read"]);
  });

  it("fails closed when no candidate is certified read-only", () => {
    const registry = createToolRegistry([
      createToolWithEffect("write", "mutating"),
      createToolWithEffect("edit", undefined)
    ]);

    expect(() => createCertifiedPlanModePolicy(registry, ["write", "edit"])).toThrow("at least one");
  });
});

function createToolWithEffect(id: string, effect: "read-only" | "mutating" | undefined): ToolDefinition {
  return {
    id,
    title: "Echo",
    description: "Return the provided message.",
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    ...(effect !== undefined ? { effect } : {}),
    execute(input) {
      return input;
    }
  };
}

function createEchoTool(id: string): ToolDefinition {
  return {
    id,
    title: "Echo",
    description: "Return the provided message.",
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    execute(input) {
      return input;
    }
  };
}
