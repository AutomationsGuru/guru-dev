import { describe, expect, it } from "vitest";

import {
  createNoopMessagingConnector,
  getConnector,
  listConnectors,
  MESSAGING_CONNECTOR_PARITY_GAP_PREFIX,
  MessagingConnectorParityGapError,
  registerConnector,
  removeConnector
} from '../../src/attach/messagingConnector.js';
import { MessagingConnectorConfigSchema } from '../../src/attach/messagingConnectorSchema.js';

describe("messaging connector ATTACH stub", () => {
  it("defaults to disabled", () => {
    const connector = registerConnector({ id: "slack-stub-default", kind: "slack" });
    try {
      expect(connector.status).toBe("disabled");
      const parsed = MessagingConnectorConfigSchema.parse({ id: "slack-stub-default", kind: "slack" });
      expect(parsed.enabled).toBe(false);
    } finally {
      removeConnector(connector.id);
    }
  });

  it("fails to enable without a parityGapId", () => {
    expect(() => createNoopMessagingConnector({ id: "teams-stub", kind: "teams", enabled: true })).toThrow(
      MessagingConnectorParityGapError
    );
    expect(() => createNoopMessagingConnector({ id: "teams-stub", kind: "teams", enabled: true })).toThrow(
      MESSAGING_CONNECTOR_PARITY_GAP_PREFIX
    );
    expect(() => registerConnector({ id: "teams-stub", kind: "teams", enabled: true })).toThrow(/parityGapId/u);
  });

  it("enables with a parityGapId and noop send returns the structured stub result", async () => {
    const connector = registerConnector({
      id: "generic-stub",
      kind: "generic",
      enabled: true,
      parityGapId: "R-CL-CONNECT",
      config: { endpointEnvVar: "GURU_STUB_WEBHOOK_ENDPOINT", tokenEnvVar: "GURU_STUB_WEBHOOK_TOKEN" }
    });
    try {
      expect(connector.status).toBe("ready");
      await connector.connect();
      expect(connector.status).toBe("enabled");

      const result = await connector.send("hello stub");
      expect(result).toEqual({
        delivered: false,
        reason: "noop-stub",
        connectorId: "generic-stub"
      });

      await connector.disconnect();
      expect(connector.status).toBe("ready");
    } finally {
      removeConnector(connector.id);
    }
  });

  it("rejects an empty connector id", () => {
    expect(() => MessagingConnectorConfigSchema.parse({ id: "", kind: "slack" })).toThrow();
    expect(() => MessagingConnectorConfigSchema.parse({ id: "   ", kind: "slack" })).toThrow();
  });

  it("schema parse rejects enabled without parityGapId (raw schema, not factory)", () => {
    const attempt = MessagingConnectorConfigSchema.safeParse({ id: "raw-slack", kind: "slack", enabled: true });
    expect(attempt.success).toBe(false);
    if (!attempt.success) {
      const gapIssue = attempt.error.issues.find((issue) => issue.path.includes("parityGapId"));
      expect(gapIssue).toBeDefined();
      expect(gapIssue?.message).toMatch(/parityGapId/u);
    }
  });

  it("schema rejects config map values that are not env-var-name shaped", () => {
    expect(() =>
      MessagingConnectorConfigSchema.parse({
        id: "raw-secret",
        kind: "slack",
        config: { token: "xoxb-1234567890-secret" }
      })
    ).toThrow(/environment variable name/u);
    expect(() =>
      MessagingConnectorConfigSchema.parse({
        id: "lowercase-value",
        kind: "slack",
        config: { endpoint: "https://hooks.slack.com/services/abc" }
      })
    ).toThrow(/environment variable name/u);
    expect(() =>
      MessagingConnectorConfigSchema.parse({
        id: "numeric-value",
        kind: "slack",
        config: { token: "1234" }
      })
    ).toThrow(/environment variable name/u);
  });

  it("schema accepts a valid config with env-name values and enabled with parityGapId", () => {
    const parsed = MessagingConnectorConfigSchema.parse({
      id: "valid-slack",
      kind: "slack",
      enabled: true,
      parityGapId: "R-CL-CONNECT",
      config: { tokenEnvVar: "GURU_SLACK_BOT_TOKEN", endpointEnvVar: "GURU_SLACK_WEBHOOK_URL" }
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.parityGapId).toBe("R-CL-CONNECT");
    expect(parsed.config.tokenEnvVar).toBe("GURU_SLACK_BOT_TOKEN");
  });

  it("registry supports register/get/list/remove", () => {
    const connector = registerConnector({ id: "discord-stub", kind: "discord" });
    try {
      expect(getConnector("discord-stub")).toBe(connector);
      expect(listConnectors().some((entry) => entry.id === "discord-stub")).toBe(true);
      expect(removeConnector("discord-stub")).toBe(true);
      expect(getConnector("discord-stub")).toBeUndefined();
    } finally {
      removeConnector(connector.id);
    }
  });
});
