import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHarnessRuntime, createInMemorySessionPersistenceStore } from "../../src/index.js";
import { startHarnessApiServer } from "../../src/surfaces/api.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type JsonResponse = {
  readonly status: number;
  readonly body: unknown;
};

async function getJson(baseUrl: URL, path: string): Promise<JsonResponse> {
  const response = await fetch(new URL(path, baseUrl));
  const body = (await response.json()) as unknown;

  return { status: response.status, body };
}

async function postJson(baseUrl: URL, path: string, body: unknown): Promise<JsonResponse> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const parsed = (await response.json()) as unknown;

  return { status: response.status, body: parsed };
}

describe("session continuation dogfood", () => {
  it("uses list, inspect, and continue helpers together on a recovered sample session", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const firstRuntime = createHarnessRuntime({ sessionPersistenceStore });
    const firstServer = await startHarnessApiServer({ port: 0, host: "127.0.0.1", runtime: firstRuntime });
    const firstUrl = new URL(firstServer.url);
    let sessionId = "";

    try {
      const startResponse = await postJson(firstUrl, "/session-start", { cwd: repoRoot });
      expect(startResponse.status).toBe(200);
      sessionId = (startResponse.body as { id?: string }).id ?? "";
      expect(sessionId).toEqual(expect.any(String));

      const toolRunResponse = await postJson(firstUrl, "/tool-run", {
        sessionId,
        toolId: "repo.context.resolve",
        input: { cwd: repoRoot }
      });
      expect(toolRunResponse.status).toBe(200);
      expect(toolRunResponse.body).toMatchObject({ observation: { status: "succeeded" } });
    } finally {
      await firstServer.close();
    }

    const recoveryRuntime = createHarnessRuntime({ sessionPersistenceStore });
    const recoveryServer = await startHarnessApiServer({ port: 0, host: "127.0.0.1", runtime: recoveryRuntime });
    const recoveryUrl = new URL(recoveryServer.url);

    try {
      const listResponse = await getJson(recoveryUrl, "/sessions?limit=1");
      expect(listResponse.status).toBe(200);
      expect(listResponse.body).toMatchObject({
        route: "session-list",
        sessions: [
          {
            sessionId,
            eventCount: 2,
            latestEventType: "tool.observation",
            taskId: "api-startup-dogfood"
          }
        ]
      });

      const selectedSessionId = (listResponse.body as { sessions?: Array<{ sessionId?: string }> }).sessions?.[0]?.sessionId;
      expect(selectedSessionId).toBe(sessionId);

      const inspectResponse = await getJson(recoveryUrl, `/sessions/${encodeURIComponent(sessionId)}/inspect`);
      expect(inspectResponse.status).toBe(200);
      expect(inspectResponse.body).toMatchObject({
        route: "session-inspect",
        sessionId,
        timeline: { eventCount: 3, toolObservations: 1, resumeBreadcrumbs: 1 },
        latestEvent: { type: "session.resumed", metadata: { requestedSessionId: sessionId, resumedSessionId: sessionId } },
        nextActions: ["Inspect the latest tool observation before continuing."]
      });

      const continueResponse = await getJson(recoveryUrl, `/sessions/${encodeURIComponent(sessionId)}/continue`);
      expect(continueResponse.status).toBe(200);
      expect(continueResponse.body).toMatchObject({
        route: "session-continue",
        sessionId,
        timeline: { eventCount: 3, toolObservations: 1, resumeBreadcrumbs: 1 },
        commands: [
          {
            label: "inspect",
            risk: "read-only",
            argv: ["guruharness", "session-inspect", "--api-url", "<api-url>", "--session-id", sessionId]
          },
          {
            label: "resume-run",
            risk: "run-lifecycle",
            argv: ["guruharness", "run", "--resume-session", sessionId]
          }
        ],
        nextActions: ["Review the suggested command before running it.", "Prefer inspection before resuming long-running work."]
      });
    } finally {
      await recoveryServer.close();
    }
  });
});
