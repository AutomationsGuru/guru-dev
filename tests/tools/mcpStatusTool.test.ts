import { describe, expect, it, beforeEach } from "vitest";

import {
  clearMcpAttachmentStatuses,
  recordMcpAttachmentStatuses
} from "../../src/mcp/statusStore.js";
import { createMcpStatusTools } from "../../src/tools/builtins/mcpStatusTool.js";

describe("mcp_bridge_status tool", () => {
  beforeEach(() => {
    clearMcpAttachmentStatuses();
  });

  it("reports empty board before any attach", async () => {
    const [tool] = createMcpStatusTools();
    const out = (await tool!.execute({}, {})) as {
      servers: unknown[];
      summary: string;
    };
    expect(out.servers).toEqual([]);
    expect(out.summary).toMatch(/No MCP attach/i);
  });

  it("returns recorded attach statuses", async () => {
    recordMcpAttachmentStatuses([
      {
        serverId: "github",
        status: "ready",
        transport: "stdio",
        missingEnvNames: [],
        toolCount: 3,
        summary: "github attached: 3 tool(s)."
      },
      {
        serverId: "slack",
        status: "missing-env",
        transport: "stdio",
        missingEnvNames: ["SLACK_TOKEN"],
        summary: "slack is missing env: SLACK_TOKEN."
      }
    ]);
    const [tool] = createMcpStatusTools();
    const out = (await tool!.execute({}, {})) as {
      servers: { serverId: string; status: string }[];
      summary: string;
      recordedAt?: string;
    };
    expect(out.servers).toHaveLength(2);
    expect(out.servers[0]?.serverId).toBe("github");
    expect(out.summary).toMatch(/2 MCP server/);
    expect(out.summary).toMatch(/1 ready/);
    expect(out.recordedAt).toBeTruthy();
  });
});
