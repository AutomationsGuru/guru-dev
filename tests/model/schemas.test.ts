import { OpenAiCompatiblePlannerModelConfigSchema, PlannerModelConfigSchema } from "../../src/index.js";

const validConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.5",
  apiKeyEnvVar: "OPENAI_API_KEY"
} as const;

describe("OpenAiCompatiblePlannerModelConfigSchema", () => {
  it("should parse a valid config with defaults", () => {
    const config = OpenAiCompatiblePlannerModelConfigSchema.parse(validConfig);

    expect(config).toMatchObject({
      ...validConfig,
      timeoutMs: 120000,
      temperature: 0
    });
  });

  it("should allow localhost HTTP endpoints for local model gateways", () => {
    expect(
      OpenAiCompatiblePlannerModelConfigSchema.safeParse({
        ...validConfig,
        baseUrl: "http://localhost:11434/v1"
      }).success
    ).toBe(true);
    expect(
      OpenAiCompatiblePlannerModelConfigSchema.safeParse({
        ...validConfig,
        baseUrl: "http://127.0.0.1:11434/v1"
      }).success
    ).toBe(true);
  });

  it("should reject invalid or insecure remote URLs", () => {
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, baseUrl: "not-a-url" }).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, baseUrl: "http://api.example/v1" }).success).toBe(false);
  });

  it("should validate apiKeyEnvVar names", () => {
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, apiKeyEnvVar: "_OPENAI_API_KEY" }).success).toBe(true);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, apiKeyEnvVar: "OPENAI_API_KEY_2" }).success).toBe(true);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, apiKeyEnvVar: "openai_api_key" }).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, apiKeyEnvVar: "2OPENAI_API_KEY" }).success).toBe(false);
  });

  it("should validate timeout boundaries", () => {
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, timeoutMs: 300000 }).success).toBe(true);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, timeoutMs: 0 }).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, timeoutMs: -1 }).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, timeoutMs: 300001 }).success).toBe(false);
  });

  it("should validate temperature boundaries", () => {
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, temperature: 0 }).success).toBe(true);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, temperature: 1 }).success).toBe(true);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, temperature: 2 }).success).toBe(true);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, temperature: -0.1 }).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, temperature: 2.1 }).success).toBe(false);
  });

  it("should reject unknown fields", () => {
    expect(
      OpenAiCompatiblePlannerModelConfigSchema.safeParse({
        ...validConfig,
        extra: true
      }).success
    ).toBe(false);
  });

  it("should reject missing required fields", () => {
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse(omitConfigField("provider")).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse(omitConfigField("baseUrl")).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse(omitConfigField("model")).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse(omitConfigField("apiKeyEnvVar")).success).toBe(false);
  });

  it("should reject invalid provider literals", () => {
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, provider: "anthropic" }).success).toBe(false);
    expect(OpenAiCompatiblePlannerModelConfigSchema.safeParse({ ...validConfig, provider: "" }).success).toBe(false);
  });
});

describe("PlannerModelConfigSchema", () => {
  it("should parse the configured model union", () => {
    expect(PlannerModelConfigSchema.parse(validConfig).provider).toBe("openai-compatible");
  });
});

function omitConfigField(field: keyof typeof validConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(validConfig).filter(([key]) => key !== field));
}
