import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { attachConfiguredMcpServers } from "../../src/mcp/attach.js";
import { McpServerConfigSchema } from "../../src/mcp/schemas.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_SERVER = join(fixtureDir, "fake-mcp-server.mjs");

describe("attachConfiguredMcpServers — one-call ATTACH with honest degradation", () => {
  it("attaches ready servers, degrades the rest to statuses, never throws", async () => {
    const attachment = await attachConfiguredMcpServers({
      env: process.env,
      servers: [
        McpServerConfigSchema.parse({
          id: "fake",
          transport: "stdio",
          command: process.execPath,
          args: [FAKE_SERVER],
          category: "test",
          timeoutMs: 10_000
        }),
        McpServerConfigSchema.parse({
          id: "keyless",
          transport: "stdio",
          command: process.execPath,
          args: [FAKE_SERVER],
          category: "test",
          requiredEnvNames: ["GURUHARNESS_TEST_KEY_THAT_IS_UNSET"]
        }),
        McpServerConfigSchema.parse({
          id: "broken",
          transport: "stdio",
          command: "definitely-not-a-real-binary-guruharness",
          category: "test",
          timeoutMs: 3_000
        })
      ]
    });

    try {
      expect(attachment.clients).toHaveLength(1);
      expect(attachment.tools.map((tool) => tool.id)).toContain("mcp.fake.echo");

      const byId = new Map(attachment.statuses.map((status) => [status.serverId, status]));
      expect(byId.get("fake")?.status).toBe("ready");
      expect(byId.get("fake")?.toolCount).toBe(4);
      expect(byId.get("keyless")?.status).toBe("missing-env");
      expect(byId.get("keyless")?.missingEnvNames).toEqual(["GURUHARNESS_TEST_KEY_THAT_IS_UNSET"]);
      expect(byId.get("broken")?.status).toBe("error");
    } finally {
      await attachment.closeAll();
    }
  });
});
