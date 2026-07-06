import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHarnessRuntime, createInMemorySessionPersistenceStore } from "../../src/index.js";
import { startHarnessApiServer } from "../../src/surfaces/api.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type JsonResponse = {
  readonly status: number;
  readonly body: unknown;
};

async function postJson(url: URL, path: string, body?: unknown): Promise<JsonResponse> {
  const target = `${path}`;

  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : "";

    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: target,
        method: "POST",
        headers: body
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload)
            }
          : {}
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          const parsed = raw.length > 0 ? JSON.parse(raw) : null;

          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      }
    );

    req.on("error", reject);

    if (body) {
      req.write(payload);
    }

    req.end();
  });
}

async function postRaw(url: URL, path: string, payload: string): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          const parsed = raw.length > 0 ? JSON.parse(raw) : null;

          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function getJson(url: URL, path: string): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path,
        method: "GET"
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          const parsed = raw.length > 0 ? JSON.parse(raw) : null;

          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

describe("startHarnessApiServer", () => {
  it("serves plan and direction routes and routes run/session-start payloads", async () => {
    let receivedSessionRequest: unknown;
    let receivedSessionListRequest: unknown;
    let receivedSessionInspectRequest: unknown;
    let receivedSessionContinuationRequest: unknown;
    let receivedToolRunRequest: unknown;
    let receivedRunRequest: unknown;

    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      handlers: {
        buildPlan: async () => ({ route: "plan", constraints: ["api-surface"] }),
        directionCheck: async () => ({ route: "direction", verdict: "GREEN" }),
        startSession: async (request) => {
          receivedSessionRequest = request;

          return { route: "session", request };
        },
        sessionInspect: async (request) => {
          receivedSessionInspectRequest = request;

          return { route: "session-inspect", request };
        },
        sessionContinue: async (request) => {
          receivedSessionContinuationRequest = request;

          return { route: "session-continue", request };
        },
        sessionList: async (request) => {
          receivedSessionListRequest = request;

          return { route: "session-list", request };
        },
        toolRun: async (request) => {
          receivedToolRunRequest = request;

          return { route: "tool-run", request };
        },
        run: async (request) => {
          receivedRunRequest = request;

          return { route: "run", request };
        },
        health: async () => ({ runtime: "guruharness-api", endpoints: ["/health"] })
      }
    });

    const url = new URL(server.url);

    const planResponse = await getJson(url, "/self-build-plan");
    expect(planResponse.status).toBe(200);
    expect(planResponse.body).toMatchObject({ route: "plan", constraints: ["api-surface"] });

    const directionResponse = await getJson(url, "/direction-check");
    expect(directionResponse.status).toBe(200);
    expect(directionResponse.body).toMatchObject({ route: "direction", verdict: "GREEN" });

    const sessionResponse = await postJson(url, "/session-start", {
      configPath: "api-config.json",
      cwd: "/tmp/project",
      targetPath: "/tmp/project/src",
      taskId: "api-tui-surfaces",
      skillIds: ["one", "two"]
    });
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.body).toMatchObject({
      route: "session",
      request: {
        configPath: "api-config.json",
        cwd: "/tmp/project",
        targetPath: "/tmp/project/src",
        taskId: "api-tui-surfaces",
        skillIds: ["one", "two"]
      }
    });
    expect(receivedSessionRequest).toMatchObject({
      configPath: "api-config.json",
      cwd: "/tmp/project",
      targetPath: "/tmp/project/src",
      taskId: "api-tui-surfaces",
      skillIds: ["one", "two"]
    });

    const sessionListResponse = await getJson(url, "/sessions?limit=3");
    expect(sessionListResponse.status).toBe(200);
    expect(sessionListResponse.body).toMatchObject({ route: "session-list", request: { limit: 3 } });
    expect(receivedSessionListRequest).toMatchObject({ limit: 3 });

    const inspectionResponse = await getJson(url, "/sessions/session-123/inspect");
    expect(inspectionResponse.status).toBe(200);
    expect(inspectionResponse.body).toMatchObject({ route: "session-inspect", request: { sessionId: "session-123" } });
    expect(receivedSessionInspectRequest).toMatchObject({ sessionId: "session-123" });

    const continuationResponse = await getJson(url, "/sessions/session-123/continue");
    expect(continuationResponse.status).toBe(200);
    expect(continuationResponse.body).toMatchObject({ route: "session-continue", request: { sessionId: "session-123" } });
    expect(receivedSessionContinuationRequest).toMatchObject({ sessionId: "session-123" });

    const toolRunResponse = await postJson(url, "/tool-run", {
      taskId: "api-tui-surfaces",
      toolId: "repo.context.resolve",
      input: { cwd: "/c/tmp/project", body: "literal /c/tmp/project content" },
      skillIds: ["one"]
    });
    expect(toolRunResponse.status).toBe(200);
    expect(toolRunResponse.body).toMatchObject({
      route: "tool-run",
      request: {
        taskId: "api-tui-surfaces",
        toolId: "repo.context.resolve",
        input: { cwd: "C:/tmp/project", body: "literal /c/tmp/project content" },
        skillIds: ["one"]
      }
    });
    expect(receivedToolRunRequest).toMatchObject({
      taskId: "api-tui-surfaces",
      toolId: "repo.context.resolve",
      input: { cwd: "C:/tmp/project", body: "literal /c/tmp/project content" },
      skillIds: ["one"]
    });

    const runResponse = await postJson(url, "/run", {
      taskId: "api-tui-surfaces",
      objective: "Surface API run",
      maxPlannerSteps: 2,
      maxPlannerRetries: 3,
      resumeSessionId: "session-123",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      git: {
        enabled: true,
        branchName: "feat/api-run",
        dryRun: true
      }
    });
    expect(runResponse.status).toBe(200);
    expect(runResponse.body).toMatchObject({
      route: "run",
      request: {
        taskId: "api-tui-surfaces",
        objective: "Surface API run",
        maxPlannerSteps: 2,
        maxPlannerRetries: 3,
        resumeSessionId: "session-123",
        git: {
          enabled: true,
          branchName: "feat/api-run",
          dryRun: true
        }
      }
    });
    expect(receivedRunRequest).toMatchObject({
      taskId: "api-tui-surfaces",
      objective: "Surface API run",
      maxPlannerSteps: 2,
      maxPlannerRetries: 3,
      resumeSessionId: "session-123",
      git: {
        enabled: true,
        branchName: "feat/api-run",
        dryRun: true
      }
    });
    expect(receivedRunRequest).not.toHaveProperty("allowDirtyWorkspace");
    expect(receivedRunRequest).not.toHaveProperty("allowRiskyPaths");

    const healthResponse = await getJson(url, "/health");
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body).toMatchObject({ runtime: "guruharness-api" });

    const missingResponse = await getJson(url, "/does-not-exist");
    expect(missingResponse.status).toBe(404);

    await server.close();
  });

  it("supports session status and running tools against an existing API session", async () => {
    const server = await startHarnessApiServer({ port: 0, host: "127.0.0.1" });
    const url = new URL(server.url);

    try {
      const sessionResponse = await postJson(url, "/session-start", { cwd: repoRoot });
      expect(sessionResponse.status).toBe(200);
      expect(sessionResponse.body).toMatchObject({ status: "ready" });
      const sessionId = (sessionResponse.body as { id?: string }).id;
      expect(sessionId).toEqual(expect.any(String));

      const statusResponse = await getJson(url, `/sessions/${sessionId}`);
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body).toMatchObject({ route: "session-status", session: { id: sessionId, status: "ready" } });

      const toolRunResponse = await postJson(url, "/tool-run", {
        sessionId,
        toolId: "repo.context.resolve",
        input: { cwd: repoRoot }
      });
      expect(toolRunResponse.status).toBe(200);
      expect(toolRunResponse.body).toMatchObject({
        session: { id: sessionId },
        observation: { status: "succeeded", output: { repoRoot } }
      });

      const eventsResponse = await getJson(url, `/sessions/${sessionId}/events`);
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.body).toMatchObject({
        route: "session-events",
        sessionId,
        summary: { sessionId, eventCount: 2, toolObservations: 1, resumeBreadcrumbs: 0 },
        events: [
          { type: "session.started", sessionId, summary: expect.stringContaining("Session started") },
          { type: "tool.observation", sessionId, summary: "Tool repo.context.resolve succeeded.", metadata: { toolId: "repo.context.resolve", status: "succeeded" } }
        ]
      });

      const inspectionResponse = await getJson(url, `/sessions/${sessionId}/inspect`);
      expect(inspectionResponse.status).toBe(200);
      expect(inspectionResponse.body).toMatchObject({
        route: "session-inspect",
        sessionId,
        session: { id: sessionId, status: "ready", taskId: "api-startup-dogfood" },
        timeline: { sessionId, eventCount: 2, toolObservations: 1, resumeBreadcrumbs: 0 },
        latestEvent: { type: "tool.observation", sessionId, metadata: { toolId: "repo.context.resolve", status: "succeeded" } },
        nextActions: ["Inspect the latest tool observation before continuing."]
      });

      const sessionListResponse = await getJson(url, "/sessions?limit=5");
      expect(sessionListResponse.status).toBe(200);
      expect(sessionListResponse.body).toMatchObject({
        route: "session-list",
        count: 1,
        sessions: [
          {
            sessionId,
            eventCount: 2,
            latestEventType: "tool.observation",
            taskId: "api-startup-dogfood"
          }
        ],
        nextActions: ["Inspect a session by id before resuming it."]
      });

      const continuationResponse = await getJson(url, `/sessions/${sessionId}/continue`);
      expect(continuationResponse.status).toBe(200);
      expect(continuationResponse.body).toMatchObject({
        route: "session-continue",
        sessionId,
        session: { id: sessionId, taskId: "api-startup-dogfood" },
        timeline: { sessionId, eventCount: 2, toolObservations: 1, resumeBreadcrumbs: 0 },
        commands: [
          { label: "inspect", risk: "read-only", argv: ["guruharness", "session-inspect", "--api-url", "<api-url>", "--session-id", sessionId] },
          { label: "resume-run", risk: "run-lifecycle", argv: ["guruharness", "run", "--resume-session", sessionId] }
        ],
        nextActions: ["Review the suggested command before running it.", "Prefer inspection before resuming long-running work."]
      });

      const missingStatusResponse = await getJson(url, "/sessions/missing-session");
      expect(missingStatusResponse.status).toBe(404);
      expect(missingStatusResponse.body).toMatchObject({ error: "Harness session not found: missing-session" });

      const missingEventsResponse = await getJson(url, "/sessions/missing-session/events");
      expect(missingEventsResponse.status).toBe(404);
      expect(missingEventsResponse.body).toMatchObject({ error: "Harness session not found: missing-session" });

      const missingInspectResponse = await getJson(url, "/sessions/missing-session/inspect");
      expect(missingInspectResponse.status).toBe(404);
      expect(missingInspectResponse.body).toMatchObject({ error: "Harness session not found: missing-session" });

      const missingContinuationResponse = await getJson(url, "/sessions/missing-session/continue");
      expect(missingContinuationResponse.status).toBe(404);
      expect(missingContinuationResponse.body).toMatchObject({ error: "Harness session not found: missing-session" });

      const missingToolRunResponse = await postJson(url, "/tool-run", {
        sessionId: "missing-session",
        toolId: "repo.context.resolve",
        input: { cwd: repoRoot }
      });
      expect(missingToolRunResponse.status).toBe(404);
      expect(missingToolRunResponse.body).toMatchObject({ error: "Harness session not found: missing-session" });
    } finally {
      await server.close();
    }
  });

  it("inspects persisted session timeline evidence after an API runtime restart", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const firstRuntime = createHarnessRuntime({ sessionPersistenceStore });
    const firstServer = await startHarnessApiServer({ port: 0, host: "127.0.0.1", runtime: firstRuntime });
    const firstUrl = new URL(firstServer.url);
    let sessionId = "";

    try {
      const sessionResponse = await postJson(firstUrl, "/session-start", { cwd: repoRoot });
      expect(sessionResponse.status).toBe(200);
      sessionId = (sessionResponse.body as { id: string }).id;

      const toolRunResponse = await postJson(firstUrl, "/tool-run", {
        sessionId,
        toolId: "repo.context.resolve",
        input: { cwd: repoRoot }
      });
      expect(toolRunResponse.status).toBe(200);
    } finally {
      await firstServer.close();
    }

    const secondRuntime = createHarnessRuntime({ sessionPersistenceStore });
    const secondServer = await startHarnessApiServer({ port: 0, host: "127.0.0.1", runtime: secondRuntime });
    const secondUrl = new URL(secondServer.url);

    try {
      const inspectionResponse = await getJson(secondUrl, `/sessions/${sessionId}/inspect`);
      expect(inspectionResponse.status).toBe(200);
      expect(inspectionResponse.body).toMatchObject({
        route: "session-inspect",
        sessionId,
        timeline: { sessionId, eventCount: 3, toolObservations: 1, resumeBreadcrumbs: 1 },
        latestEvent: { type: "session.resumed", sessionId },
        nextActions: ["Inspect the latest tool observation before continuing."]
      });
      expect((inspectionResponse.body as { latestEvent?: { metadata?: unknown } }).latestEvent?.metadata).toMatchObject({
        requestedSessionId: sessionId,
        resumedSessionId: sessionId
      });
    } finally {
      await secondServer.close();
    }
  });

  it("returns a clear error for invalid JSON request bodies", async () => {
    const server = await startHarnessApiServer({ port: 0, host: "127.0.0.1" });
    const url = new URL(server.url);

    try {
      const response = await postRaw(url, "/tool-run", "{not-json");

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: expect.stringContaining("Invalid JSON request body"), route: "/tool-run", method: "POST" });
    } finally {
      await server.close();
    }
  });

  it("passes /run safety overrides only when the API server opts in", async () => {
    let receivedRunRequest: unknown;
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      allowRunSafetyOverrides: true,
      handlers: {
        run: async (request) => {
          receivedRunRequest = request;

          return { route: "run", request };
        }
      }
    });

    const response = await postJson(new URL(server.url), "/run", {
      taskId: "api-tui-surfaces",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true
    });

    expect(response.status).toBe(200);
    expect(receivedRunRequest).toMatchObject({
      taskId: "api-tui-surfaces",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true
    });

    await server.close();
  });
});
