import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Import from the module under test (will be RED until implemented)
import {
  createMultiAgentOaiServe,
  routeToAgentId,
  type MultiAgentOaiServeOptions,
} from '../../src/serve/multiAgentOaiServe.js';

describe("multiAgentOaiServe", () => {
  describe("routeToAgentId", () => {
    it("extracts agentId from x-agent-id header (case-insensitive)", () => {
      const id = routeToAgentId({
        headers: { "x-agent-id": "fleet-alpha-7" },
      });
      expect(id).toBe("fleet-alpha-7");
    });

    it("extracts agentId from X-Agent-Id header", () => {
      const id = routeToAgentId({
        headers: { "X-Agent-Id": "fleet-beta-9" },
      });
      expect(id).toBe("fleet-beta-9");
    });

    it("falls back to body.agent or body.routing.agentId", () => {
      expect(
        routeToAgentId({ body: { agent: "fleet-gamma" } })
      ).toBe("fleet-gamma");
      expect(
        routeToAgentId({ body: { routing: { agentId: "fleet-delta" } } })
      ).toBe("fleet-delta");
    });

    it("returns null when no routing info present", () => {
      expect(routeToAgentId({})).toBeNull();
    });
  });

  describe("HTTP stub server", () => {
    let server: ReturnType<typeof createServer>;
    let baseUrl: string;
    let port: number;

    beforeAll(async () => {
      const options: MultiAgentOaiServeOptions = {
        agents: {
          "fleet-alpha-7": { id: "fleet-alpha-7", model: "stub" },
          "fleet-beta-9": { id: "fleet-beta-9", model: "stub" },
        },
      };
      const app = createMultiAgentOaiServe(options);
      server = createServer(app);
      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          const addr = server.address() as AddressInfo;
          port = addr.port;
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("routes known agent via header and returns 200 stub chat completion", async () => {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-id": "fleet-alpha-7",
        },
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("id");
      expect(json.choices?.[0]?.message?.content).toContain("fleet-alpha-7");
    });

    it("returns 400 for unknown agent", async () => {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-id": "unknown-fleet-xyz",
        },
        body: JSON.stringify({ model: "gpt-5", messages: [] }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/unknown agent/i);
    });
  });
});
