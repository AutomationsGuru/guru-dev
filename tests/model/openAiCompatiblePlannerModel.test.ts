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

    const plan = (await model.createPlan(request)) as PlannerPlan;

    expect(plan.steps[0]?.toolId).toBe("repo.context.resolve");
    expect(calls[0]?.url).toBe("https://models.example/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
    const body = JSON.parse(String(calls[0]?.init.body)) as { model?: string; response_format?: { type?: string }; messages?: unknown[] };
    expect(body.model).toBe("test-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
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

    await expect(model.createPlan(request)).resolves.toMatchObject({ objective: "No-op", steps: [] });
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
