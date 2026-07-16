import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHarnessRuntime, createInMemorySessionPersistenceStore } from "../../src/index.js";
import { BootReportSchema, runBootRitual } from "../../src/boot/ritual.js";
import type { RunSelfBuildExecutorOptions, SelfBuildExecutorReport } from "../../src/executor/selfBuildExecutor.js";
import { MandateStateSchema } from "../../src/mandates/schema.js";
import { runDevCycle, type DevCycleReport, type RunDevCycleInput } from "../../src/selfbuild/runDevCycle.js";
import { startHarnessApiServer } from "../../src/surfaces/api.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type JsonResponse = {
  readonly status: number;
  readonly body: unknown;
};

function fakeExecutorReport(): SelfBuildExecutorReport {
  return {
    verdict: "YELLOW",
    session: {} as SelfBuildExecutorReport["session"],
    planner: { status: "completed" } as SelfBuildExecutorReport["planner"],
    plannerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    plannerFallback: null,
    observability: {} as SelfBuildExecutorReport["observability"],
    reviewGates: null,
    gitPr: null,
    implementation: {} as SelfBuildExecutorReport["implementation"],
    blocker: null,
    donePacket: {} as SelfBuildExecutorReport["donePacket"],
    summary: "deterministic API executor fixture",
    nextActions: []
  };
}

function runGreenApiCycle(input: RunDevCycleInput): Promise<DevCycleReport> {
  return runDevCycle({
    ...input,
    stages: {
      test: async () => ({ verdict: "GREEN", evidence: "deterministic TEST" }),
      smoke: async () => ({ verdict: "GREEN", evidence: "deterministic SMOKE" }),
      ship: async () => ({ verdict: "GREEN", evidence: "deterministic SHIP" })
    }
  });
}

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
  // Session start + tool-run + inspect chains are integration-heavy; allow headroom under parallel CI load.
  const integrationTimeoutMs = 30_000;

  it("runs the headless boot ritual once at startup and retains its strict report in health", async () => {
    let ritualCalls = 0;
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      boot: {
        sessionNumber: 17,
        phaseData: {
          kernel: { runtimeName: "guruharness", runtimeVersion: "1.5.0", resolverReady: true },
          garage: { manifestCount: 2, verifiedLayerCount: 2, staleLayerCount: 0 },
          memory: { provider: "markdown", status: "ready", injectedFactCount: 3 }
        },
        workDeclaration: { availableCapabilityCount: 5, missingCapabilityCount: 0 },
        baselineHealth: () => ({ verdict: "GREEN" as const, durationMs: 4 }),
        ritualRunner: (hooks, sessionNumber) => {
          ritualCalls += 1;
          return runBootRitual(hooks, sessionNumber);
        }
      }
    });

    try {
      const firstHealth = await getJson(new URL(server.url), "/health");
      const secondHealth = await getJson(new URL(server.url), "/health");
      const report = BootReportSchema.parse((firstHealth.body as { boot?: unknown }).boot);

      expect(firstHealth.status).toBe(200);
      expect(secondHealth.status).toBe(200);
      expect(ritualCalls).toBe(1);
      expect(report).toMatchObject({
        sessionNumber: 17,
        phases: [
          { phase: "kernel", ordinal: 1 },
          { phase: "garage", ordinal: 2 },
          { phase: "memory", ordinal: 3 },
          { phase: "work", ordinal: 4 },
          { phase: "health", ordinal: 5, status: "ok" }
        ]
      });
      expect((secondHealth.body as { boot?: unknown }).boot).toEqual(report);
    } finally {
      await server.close();
    }
  });

  it("retains all five health phases and keeps serving when one boot hook warns", async () => {
    let ritualCalls = 0;
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      boot: {
        sessionNumber: 18,
        phaseData: {
          kernel: { runtimeName: "guruharness", runtimeVersion: "1.5.0", resolverReady: true },
          garage: { manifestCount: 1, verifiedLayerCount: 1, staleLayerCount: 0 },
          memory: { provider: "markdown", status: "ready", injectedFactCount: 1 }
        },
        workDeclaration: { availableCapabilityCount: 2, missingCapabilityCount: 0 },
        baselineHealth: () => ({ verdict: "GREEN" as const }),
        ritualRunner: (hooks, sessionNumber) => {
          ritualCalls += 1;
          return runBootRitual(
            {
              ...hooks,
              inspectGarage: () => {
                throw new Error("synthetic garage hook failure");
              }
            },
            sessionNumber
          );
        }
      }
    });

    try {
      const health = await getJson(new URL(server.url), "/health");
      const report = BootReportSchema.parse((health.body as { boot?: unknown }).boot);

      expect(health.status).toBe(200);
      expect(ritualCalls).toBe(1);
      expect(report.phases).toHaveLength(5);
      expect(report.phases[1]).toMatchObject({
        phase: "garage",
        status: "warn",
        lines: ["phase hook failed; continuing"]
      });
      expect(report.phases.slice(2).map((phase) => phase.phase)).toEqual(["memory", "work", "health"]);
      expect(report.phases[4]).toMatchObject({ phase: "health", status: "ok" });
    } finally {
      await server.close();
    }
  });

  it("closes an internally constructed runtime with the HTTP server", async () => {
    const runtime = createHarnessRuntime();
    const closeRuntime = runtime.close.bind(runtime);
    let closeCalls = 0;
    runtime.close = async () => {
      closeCalls += 1;
      await closeRuntime();
    };
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      runtimeFactory: () => runtime
    });

    await server.close();

    expect(closeCalls).toBe(1);
    await expect(runtime.startSession()).rejects.toThrow("Harness runtime is closed");
  });

  it("leaves an injected runtime open when the HTTP server closes", async () => {
    const runtime = createHarnessRuntime();
    const closeRuntime = runtime.close.bind(runtime);
    let closeCalls = 0;
    runtime.close = async () => {
      closeCalls += 1;
      await closeRuntime();
    };
    const server = await startHarnessApiServer({ port: 0, host: "127.0.0.1", runtime });

    await server.close();

    expect(closeCalls).toBe(0);
    const session = await runtime.startSession({ cwd: repoRoot });
    expect(session.status).toBe("ready");
    await runtime.close();
  });

  it("serves plan and direction routes and routes run/session-start payloads", async () => {
    let receivedPlanRequest: unknown;
    let receivedDirectionRequest: unknown;
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
        buildPlan: async (request) => {
          receivedPlanRequest = request;

          return { route: "plan", constraints: ["api-surface"], request };
        },
        directionCheck: async (request) => {
          receivedDirectionRequest = request;

          return { route: "direction", verdict: "GREEN", request };
        },
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

    const planResponse = await getJson(url, "/self-build-plan?config=/d/guru/config.json&cwd=/c/tmp/project");
    expect(planResponse.status).toBe(200);
    expect(planResponse.body).toMatchObject({ route: "plan", constraints: ["api-surface"], request: { configPath: "D:/guru/config.json", cwd: "C:/tmp/project" } });
    expect(receivedPlanRequest).toMatchObject({ configPath: "D:/guru/config.json", cwd: "C:/tmp/project" });

    const directionResponse = await getJson(url, "/direction-check?config=/e/guru/config.json&cwd=/f/workspace");
    expect(directionResponse.status).toBe(200);
    expect(directionResponse.body).toMatchObject({ route: "direction", verdict: "GREEN", request: { configPath: "E:/guru/config.json", cwd: "F:/workspace" } });
    expect(receivedDirectionRequest).toMatchObject({ configPath: "E:/guru/config.json", cwd: "F:/workspace" });

    const sessionResponse = await postJson(url, "/session-start", {
      configPath: "/g/api-config.json",
      cwd: "/c/tmp/project",
      targetPath: "/d/tmp/project/src",
      taskId: "api-tui-surfaces",
      skillIds: ["one", "two"]
    });
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.body).toMatchObject({
      route: "session",
      request: {
        configPath: "G:/api-config.json",
        cwd: "C:/tmp/project",
        targetPath: "D:/tmp/project/src",
        taskId: "api-tui-surfaces",
        skillIds: ["one", "two"]
      }
    });
    expect(receivedSessionRequest).toMatchObject({
      configPath: "G:/api-config.json",
      cwd: "C:/tmp/project",
      targetPath: "D:/tmp/project/src",
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
      configPath: "/h/tool-config.json",
      cwd: "/i/tool-cwd",
      targetPath: "/j/tool-target",
      taskId: "api-tui-surfaces",
      toolId: "repo.context.resolve",
      input: { cwd: "/c/tmp/project", body: "literal /c/tmp/project content" },
      skillIds: ["one"]
    });
    expect(toolRunResponse.status).toBe(200);
    expect(toolRunResponse.body).toMatchObject({
      route: "tool-run",
      request: {
        configPath: "H:/tool-config.json",
        cwd: "I:/tool-cwd",
        targetPath: "J:/tool-target",
        taskId: "api-tui-surfaces",
        toolId: "repo.context.resolve",
        input: { cwd: "C:/tmp/project", body: "literal /c/tmp/project content" },
        skillIds: ["one"]
      }
    });
    expect(receivedToolRunRequest).toMatchObject({
      configPath: "H:/tool-config.json",
      cwd: "I:/tool-cwd",
      targetPath: "J:/tool-target",
      taskId: "api-tui-surfaces",
      toolId: "repo.context.resolve",
      input: { cwd: "C:/tmp/project", body: "literal /c/tmp/project content" },
      skillIds: ["one"]
    });

    const runResponse = await postJson(url, "/run", {
      configPath: "/k/run-config.json",
      cwd: "/l/run-cwd",
      targetPath: "/m/run-target",
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
        configPath: "K:/run-config.json",
        cwd: "L:/run-cwd",
        targetPath: "M:/run-target",
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
      configPath: "K:/run-config.json",
      cwd: "L:/run-cwd",
      targetPath: "M:/run-target",
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
    // Real session start + tool-run + inspect chain can exceed the default 5s under load.
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
  }, integrationTimeoutMs);

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
  }, integrationTimeoutMs);

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
  }, integrationTimeoutMs);

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

  it("routes the default /run through P7 with translated executor options and live smoke deps", async () => {
    let cycleEntered = false;
    let receivedCycleInput: RunDevCycleInput | undefined;
    let receivedExecutorOptions: RunSelfBuildExecutorOptions | undefined;
    const configPath = resolve(repoRoot, "guruharness.config.json");
    const targetPath = resolve(repoRoot, "src");
    const gitPath = resolve(repoRoot, "src/surfaces/api.ts");
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      allowRunSafetyOverrides: true,
      runExecutor: async (options) => {
        if (!cycleEntered) {
          throw new Error("legacy direct executor call bypassed P7");
        }
        receivedExecutorOptions = options;
        return fakeExecutorReport();
      },
      runCycle: async (input) => {
        receivedCycleInput = input;
        cycleEntered = true;
        try {
          return await runGreenApiCycle(input);
        } finally {
          cycleEntered = false;
        }
      }
    });

    try {
      const response = await postJson(new URL(server.url), "/run", {
        configPath,
        cwd: repoRoot,
        targetPath,
        taskId: "api-p7",
        objective: "exercise the P7 API envelope",
        projectSlug: "api-p7-project",
        maxPlannerSteps: 7,
        maxPlannerRetries: 3,
        allowDirtyWorkspace: true,
        allowRiskyPaths: true,
        resumeSessionId: "resume-p7",
        includeReviewGate: true,
        git: { dryRun: true, baseBranch: "main", branchName: "api-p7", paths: [gitPath] }
      });

      expect(response).toMatchObject({
        status: 200,
        body: {
          verdict: "YELLOW",
          terminal: "done",
          stages: [
            { stage: "select", verdict: "GREEN" },
            { stage: "build", verdict: "GREEN" },
            { stage: "test", verdict: "GREEN" },
            { stage: "smoke", verdict: "GREEN" },
            { stage: "review", verdict: "YELLOW" },
            { stage: "ship", verdict: "GREEN" },
            { stage: "learn", verdict: "YELLOW" }
          ],
          executor: { planner: { status: "completed" }, summary: "deterministic API executor fixture" },
          learned: { taskId: "api-p7", outcome: "shipped", confidence: "parked" },
          ledger: [],
          summary: expect.stringContaining("dev cycle completed")
        }
      });
      expect(receivedCycleInput?.executorOptions).toMatchObject({
        configPath,
        cwd: repoRoot,
        targetPath,
        taskId: "api-p7",
        objective: "exercise the P7 API envelope",
        projectSlug: "api-p7-project",
        maxPlannerSteps: 7,
        maxPlannerRetries: 3,
        allowDirtyWorkspace: true,
        allowRiskyPaths: true,
        resumeSessionId: "resume-p7",
        includeReviewGate: true,
        git: { enabled: true, dryRun: true, baseBranch: "main", branchName: "api-p7", paths: [gitPath] }
      });
      expect(receivedCycleInput?.executorOptions).not.toHaveProperty("mandatePolicy");
      expect(receivedCycleInput?.executor).toEqual(expect.any(Function));
      expect(receivedCycleInput?.mandatePolicy).toEqual(expect.any(Function));
      expect(receivedCycleInput?.smoke).toMatchObject({ timeoutMs: 30_000 });
      expect(receivedCycleInput?.smoke?.runSmoke).toEqual(expect.any(Function));
      expect(receivedCycleInput?.smoke?.selfCall).toEqual(expect.any(Function));
      expect(receivedExecutorOptions?.includeReviewGate).toBe(false);
      expect(receivedExecutorOptions?.mandatePolicy).toBe(receivedCycleInput?.mandatePolicy);
    } finally {
      await server.close();
    }
  });

  it("passes the server-owned read-only mandate to P7 and strips request-owned access fields", async () => {
    let receivedCycleInput: RunDevCycleInput | undefined;
    let receivedOptions: RunSelfBuildExecutorOptions | undefined;
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      runExecutor: async (options) => {
        receivedOptions = options;
        return fakeExecutorReport();
      },
      runCycle: async (input) => {
        receivedCycleInput = input;
        return runGreenApiCycle(input);
      }
    });

    try {
      const response = await postJson(new URL(server.url), "/run", {
        cwd: repoRoot,
        mandate: {
          grants: [{ scope: "machine", verbs: ["write", "exec"], grantedAt: "request-owned" }],
          denies: []
        },
        grants: [{ scope: "machine", verbs: ["write", "exec"], grantedAt: "request-owned" }],
        yolo: true
      });

      expect(response).toMatchObject({ status: 200, body: { terminal: "done", executor: { planner: { status: "completed" } } } });
      expect(receivedCycleInput?.executorOptions).not.toHaveProperty("mandate");
      expect(receivedCycleInput?.executorOptions).not.toHaveProperty("grants");
      expect(receivedCycleInput?.executorOptions).not.toHaveProperty("yolo");
      expect(receivedOptions).not.toHaveProperty("mandate");
      expect(receivedOptions).not.toHaveProperty("grants");
      expect(receivedOptions).not.toHaveProperty("yolo");

      const policy = receivedCycleInput?.mandatePolicy;
      expect(policy).toEqual(expect.any(Function));
      if (!policy) {
        throw new Error("default /run did not give P7 a mandate policy");
      }

      expect(policy("read", { path: "README.md" }, repoRoot)?.outcome).toBe("allow");
      expect(policy("write", { path: "src/ordinary.ts" }, repoRoot)?.outcome).toBe("escalate");
      expect(policy("bash", { command: "npm test" }, repoRoot)?.outcome).toBe("escalate");
    } finally {
      await server.close();
    }
  });

  it("honors covering server grants while scoped denies and hard edges remain binding", async () => {
    let receivedCycleInput: RunDevCycleInput | undefined;
    const blockedDirectory = resolve(repoRoot, "blocked");
    const mandate = MandateStateSchema.parse({
      grants: [
        {
          scope: "space",
          path: repoRoot,
          verbs: ["read", "write", "exec", "destructive", "spend", "secret-edge", "auth-edge"],
          grantedAt: "2026-07-15T00:00:00.000Z"
        }
      ],
      denies: [{ verb: "write", path: blockedDirectory, note: "keep blocked subtree immutable" }]
    });
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      mandate,
      runExecutor: async () => fakeExecutorReport(),
      runCycle: async (input) => {
        receivedCycleInput = input;
        return runGreenApiCycle(input);
      }
    });

    try {
      const response = await postJson(new URL(server.url), "/run", { cwd: repoRoot });
      expect(response.status).toBe(200);

      const policy = receivedCycleInput?.mandatePolicy;
      expect(policy).toEqual(expect.any(Function));
      if (!policy) {
        throw new Error("default /run did not give P7 the configured mandate policy");
      }

      expect(policy("write", { path: "src/allowed.ts" }, repoRoot)?.outcome).toBe("allow");
      expect(policy("bash", { command: "npm test" }, repoRoot)?.outcome).toBe("allow");
      expect(policy("write", { path: resolve(blockedDirectory, "denied.ts") }, repoRoot)?.outcome).toBe("deny");
      expect(policy("bash", { command: "rm -rf build" }, repoRoot)?.outcome).toBe("escalate");
      expect(policy("bash", { command: "terraform apply -auto-approve" }, repoRoot)?.outcome).toBe("escalate");
      expect(policy("write", { path: "config/.env" }, repoRoot)?.outcome).toBe("escalate");
      expect(policy("write", { path: ".aws/credentials" }, repoRoot)?.outcome).toBe("escalate");
    } finally {
      await server.close();
    }
  });

  it("returns a blocked P7 report when TEST passes and a synthetic SMOKE failure cannot be repaired", async () => {
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      runExecutor: async () => fakeExecutorReport(),
      runCycle: (input) =>
        runDevCycle({
          ...input,
          stages: {
            test: async () => ({ verdict: "GREEN", evidence: "deterministic TEST" }),
            smoke: async () => ({ verdict: "RED", evidence: "synthetic capability-smoke RED" }),
            debug: async () => ({ verdict: "RED", evidence: "synthetic repair unavailable" })
          }
        })
    });

    try {
      const response = await postJson(new URL(server.url), "/run", { cwd: repoRoot, taskId: "smoke-red" });

      expect(response).toMatchObject({
        status: 200,
        body: {
          verdict: "RED",
          terminal: "blocked",
          stages: [
            { stage: "select", verdict: "GREEN" },
            { stage: "build", verdict: "GREEN" },
            { stage: "test", verdict: "GREEN" },
            { stage: "smoke", verdict: "RED", evidence: "synthetic capability-smoke RED" },
            { stage: "debug", verdict: "RED" }
          ],
          executor: { planner: { status: "completed" } },
          learned: { taskId: "smoke-red", outcome: "blocked" },
          summary: expect.stringContaining("dev cycle blocked")
        }
      });
      expect((response.body as { stages: Array<{ stage: string }> }).stages.some((stage) => stage.stage === "review")).toBe(false);
      expect((response.body as { stages: Array<{ stage: string }> }).stages.some((stage) => stage.stage === "ship")).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("keeps injected /run handlers unchanged and bypasses the default cycle", async () => {
    let receivedRunRequest: unknown;
    let executorCalls = 0;
    let cycleCalls = 0;
    const server = await startHarnessApiServer({
      port: 0,
      host: "127.0.0.1",
      runExecutor: async () => {
        executorCalls += 1;
        return fakeExecutorReport();
      },
      runCycle: async () => {
        cycleCalls += 1;
        throw new Error("unexpected default cycle");
      },
      handlers: {
        run: async (request) => {
          receivedRunRequest = request;
          return { route: "custom-run", request };
        }
      }
    });

    try {
      const response = await postJson(new URL(server.url), "/run", {
        cwd: repoRoot,
        objective: "preserve custom handler",
        mandate: { grants: [], denies: [] },
        grants: [{ scope: "machine", verbs: ["write"], grantedAt: "request-owned" }],
        yolo: true
      });

      expect(response).toMatchObject({ status: 200, body: { route: "custom-run" } });
      expect(executorCalls).toBe(0);
      expect(cycleCalls).toBe(0);
      expect(receivedRunRequest).toMatchObject({ cwd: repoRoot, objective: "preserve custom handler" });
      expect(receivedRunRequest).not.toHaveProperty("mandate");
      expect(receivedRunRequest).not.toHaveProperty("grants");
      expect(receivedRunRequest).not.toHaveProperty("yolo");
    } finally {
      await server.close();
    }
  });
});
