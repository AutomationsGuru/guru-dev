import {
  createOpenAiCompatiblePlannerModel,
  createPlannerModelFromConfig,
  type PlannerModelFetch
} from "../../src/index.js";
import type { PlannerModelRequest, PlannerPlan } from "../../src/planner/schemas.js";

const config = {
  provider: "openai-compatible" as const,
  baseUrl: "https://models.example/v1",
  model: "test-model",
  apiKeyEnvVar: "TEST_MODEL_KEY",
  timeoutMs: 1000,
  temperature: 0
};

const request: PlannerModelRequest = {
  objective: "Inspect repo.",
  session: {
    id: "session-1",
    runtimeName: "GuruHarness",
    status: "ready",
    startedAt: new Date("2026-06-15T00:00:00.000Z").toISOString(),
    task: {
      id: "model-adapter",
      title: "Add production model adapter",
      description: "Connect planner runtime to a configured real model provider.",
      thereContribution: "Turns injected planner contracts into actual model-backed harness execution."
    },
    here: "GuruHarness is currently a harness substrate with planner runtime and self-build executor support.",
    there: "GuruHarness is a working independent agent harness with model-backed execution.",
    direction: {
      here: "GuruHarness is currently a harness substrate with planner runtime and self-build executor support.",
      there: "GuruHarness is a working independent agent harness with model-backed execution.",
      verdict: "GREEN",
      checks: [],
      summary: "GREEN: aligned."
    },
    config: {
      status: "loaded",
      verdict: "GREEN",
      path: "guruharness.config.json",
      diagnostics: [],
      runtimeName: "GuruHarness",
      referenceRuntime: "a reference agent runtime"
    },
    repo: null,
    skills: { catalog: { skills: [], directories: [], diagnostics: [] }, loaded: [] },
    memory: { provider: "in-memory-operational-store", status: "available", projectSlug: "guruharness" },
    policy: {
      validationCommands: ["test"],
      reviewGate: { provider: "native-critic-panel", required: true },
      approvalPolicy: { autoCommitPushPr: true, allowLocalMerge: false, allowForcePush: false }
    },
    tools: [{ id: "repo.context.resolve", title: "Resolve repository context", description: "Resolve repo context." }],
    blockers: [],
    nextActions: []
  },
  tools: [{ id: "repo.context.resolve", title: "Resolve repository context", description: "Resolve repo context." }]
};

describe("createOpenAiCompatiblePlannerModel", () => {
  it("should call an OpenAI-compatible chat completions endpoint and parse a planner plan", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = createJsonFetch(calls, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              objective: "Inspect repo.",
              summary: "Resolve repo context.",
              steps: [{ id: "repo", title: "Resolve repo", toolId: "repo.context.resolve", input: {} }]
            })
          }
        }
      ]
    });
    const model = createOpenAiCompatiblePlannerModel({ config, env: { TEST_MODEL_KEY: "test-key" }, fetch: fetchImpl });

    const result = (await model.createPlan(request)) as { readonly plan: PlannerPlan; readonly usage?: unknown };

    expect(result.plan.steps[0]?.toolId).toBe("repo.context.resolve");
    expect(result).not.toHaveProperty("usage");
    expect(calls[0]?.url).toBe("https://models.example/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
    const body = JSON.parse(String(calls[0]?.init.body)) as { model?: string; response_format?: { type?: string }; messages?: unknown[] };
    expect(body.model).toBe("test-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
  });

  it("should return validated input, output, and total token usage", async () => {
    const fetchImpl = createJsonFetch([], {
      choices: [
        {
          message: {
            content: JSON.stringify({ objective: "No-op", summary: "No tools needed.", steps: [] })
          }
        }
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    });
    const model = createOpenAiCompatiblePlannerModel({ config, env: { TEST_MODEL_KEY: "test-key" }, fetch: fetchImpl });

    await expect(model.createPlan(request)).resolves.toEqual({
      plan: { objective: "No-op", summary: "No tools needed.", steps: [] },
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
    });
  });

  it.each([
    ["negative input", { prompt_tokens: -1, completion_tokens: 2 }],
    ["fractional output", { prompt_tokens: 1, completion_tokens: 1.5 }],
    ["malformed total", { prompt_tokens: 1, completion_tokens: 2, total_tokens: "do-not-leak-usage" }],
    ["inconsistent total", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 4 }]
  ])("should reject %s token usage without leaking response content", async (_label, usage) => {
    const fetchImpl = createJsonFetch([], {
      choices: [
        {
          message: {
            content: JSON.stringify({ objective: "No-op", summary: "No tools needed.", steps: [] })
          }
        }
      ],
      usage
    });
    const model = createOpenAiCompatiblePlannerModel({ config, env: { TEST_MODEL_KEY: "test-key" }, fetch: fetchImpl });

    let caught: unknown;
    try {
      await model.createPlan(request);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("do-not-leak-usage");
  });

  it("should parse fenced JSON content", async () => {
    const fetchImpl = createJsonFetch([], {
      choices: [
        {
          message: {
            content: "```json\n{\"objective\":\"No-op\",\"summary\":\"No tools needed.\",\"steps\":[]}\n```"
          }
        }
      ]
    });
    const model = createOpenAiCompatiblePlannerModel({ config, env: { TEST_MODEL_KEY: "test-key" }, fetch: fetchImpl });

    await expect(model.createPlan(request)).resolves.toMatchObject({ plan: { objective: "No-op", steps: [] } });
  });

  it("should fail before network when the configured api key env var is missing", async () => {
    const calls: unknown[] = [];
    const model = createOpenAiCompatiblePlannerModel({ config, env: {}, fetch: createJsonFetch(calls, {}) });

    await expect(model.createPlan(request)).rejects.toThrow("TEST_MODEL_KEY");
    expect(calls).toEqual([]);
  });

  it("should include HTTP status and a redacted-size response excerpt for failed requests", async () => {
    const model = createOpenAiCompatiblePlannerModel({
      config,
      env: { TEST_MODEL_KEY: "test-key" },
      fetch: async () => ({ ok: false, status: 429, text: async () => "rate limited" })
    });

    await expect(model.createPlan(request)).rejects.toThrow("HTTP 429: rate limited");
  });

  it("should reject invalid model JSON plans", async () => {
    const model = createOpenAiCompatiblePlannerModel({
      config,
      env: { TEST_MODEL_KEY: "test-key" },
      fetch: createJsonFetch([], { choices: [{ message: { content: "{\"objective\":\"missing summary\"}" } }] })
    });

    await expect(model.createPlan(request)).rejects.toThrow();
  });
});

describe("createPlannerModelFromConfig", () => {
  it("should return undefined when no model config is available", () => {
    expect(createPlannerModelFromConfig(undefined)).toBeUndefined();
  });
});

function createJsonFetch(calls: unknown[], body: unknown): PlannerModelFetch {
  return async (url, init) => {
    calls.push({ url, init });

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body)
    };
  };
}
