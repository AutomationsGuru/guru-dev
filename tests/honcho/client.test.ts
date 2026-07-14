import { createHonchoClient, createInMemoryHonchoClient } from "../../src/honcho/client.js";
import { HonchoConfigSchema } from "../../src/honcho/schemas.js";

function makeClient(configOverrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const config = HonchoConfigSchema.parse({
    workspaceId: "guruharness",
    requiredEnvNames: ["HONCHO_API_KEY"],
    ...configOverrides
  });

  return createInMemoryHonchoClient({ config, env });
}

const baseRemember = { peer: "user" as const, writeEnabled: false, userApproved: false };
const baseRecall = { reasoningLevel: "minimal" as const, limit: 10, includeRaw: false };

describe("createHonchoClient production adapter", () => {
  it("is honestly disabled by default instead of impersonating a live memory service", async () => {
    const status = await createHonchoClient({ config: HonchoConfigSchema.parse({ workspaceId: "guruharness" }) }).status();

    expect(status).toMatchObject({ status: "disabled", writeEnabled: false, missingEnvNames: [] });
  });

  it("reports the configured key NAME when enabled but not configured", async () => {
    const status = await createHonchoClient({
      config: HonchoConfigSchema.parse({ enabled: true, workspaceId: "guruharness", apiKeyEnvVar: "TEAM_HONCHO_API_KEY" }),
      env: {}
    }).status();

    expect(status).toMatchObject({ status: "missing-env", missingEnvNames: ["TEAM_HONCHO_API_KEY"] });
  });
});

describe("createInMemoryHonchoClient.status", () => {
  it("reports missing-env when a required env NAME is absent", async () => {
    const status = await makeClient({}, {}).status();

    expect(status.status).toBe("missing-env");
    expect(status.missingEnvNames).toContain("HONCHO_API_KEY");
    expect(status.writeEnabled).toBe(false);
  });

  it("reports read-only when the required env is present but writeEnabled is false", async () => {
    const status = await makeClient({ enabled: true, writeEnabled: false }, { HONCHO_API_KEY: "present" }).status();

    expect(status.status).toBe("read-only");
    expect(status.missingEnvNames).toEqual([]);
  });

  it("reports ready when the required env is present and writeEnabled is true", async () => {
    const status = await makeClient({ enabled: true, writeEnabled: true }, { HONCHO_API_KEY: "present" }).status();

    expect(status.status).toBe("ready");
    expect(status.writeEnabled).toBe(true);
  });

  it("never echoes a secret VALUE — env names only", async () => {
    const status = await makeClient({}, { HONCHO_API_KEY: "super-secret-value" }).status();

    expect(JSON.stringify(status)).not.toContain("super-secret-value");
  });
});

describe("createInMemoryHonchoClient write gates", () => {
  it("blocks remember without writeEnabled + userApproved", async () => {
    const result = await makeClient({}, { HONCHO_API_KEY: "present" }).remember({ ...baseRemember, fact: "hello" });

    expect(result.status).toBe("blocked");
  });

  it("stores and recalls a fact when write-enabled and approved", async () => {
    const client = makeClient({ writeEnabled: true }, { HONCHO_API_KEY: "present" });
    const stored = await client.remember({
      ...baseRemember,
      fact: "guruharness uses zod-strict schemas",
      writeEnabled: true,
      userApproved: true
    });

    expect(stored.status).toBe("succeeded");

    const recalled = await client.recall({ ...baseRecall, query: "zod" });
    expect(recalled.items.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks writing a value that looks like a secret", async () => {
    const result = await makeClient({ writeEnabled: true }, { HONCHO_API_KEY: "present" }).remember({
      ...baseRemember,
      fact: "api_key=abcdef0123456789",
      writeEnabled: true,
      userApproved: true
    });

    expect(result.status).toBe("blocked");
    expect(result.summary.toLowerCase()).toContain("secret");
  });
});
