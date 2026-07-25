import { request } from "node:http";

import { startHarnessApiServer, type ApiServerHandle } from '../../src/surfaces/api.js';

type SseFrame = {
  readonly event?: string;
  readonly data?: string;
};

type SseReader = {
  readonly frames: SseFrame[];
  readonly contentType: string;
  close(): void;
};

type WorkspaceFrameMetadata = {
  readonly workspaceEventType: string;
  readonly workspaceKey: string;
  readonly attachedClients: number;
  readonly isBusy: boolean;
  readonly clientId?: string;
  readonly sessionId?: string;
  readonly precedence?: string;
};

function parseSseChunk(buffer: { raw: string }, frames: SseFrame[]): void {
  let boundary = buffer.raw.indexOf("\n\n");
  while (boundary !== -1) {
    const text = buffer.raw.slice(0, boundary);
    buffer.raw = buffer.raw.slice(boundary + 2);
    let event: string | undefined;
    let data: string | undefined;
    for (const line of text.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data = line.slice("data:".length).trim();
      }
    }
    if (event !== undefined || data !== undefined) {
      frames.push({ ...(event !== undefined ? { event } : {}), ...(data !== undefined ? { data } : {}) });
    }
    boundary = buffer.raw.indexOf("\n\n");
  }
}

function openEventStream(url: URL, path: string, options: { readonly lastEventId?: number } = {}): SseReader {
  const frames: SseFrame[] = [];
  const buffer = { raw: "" };
  let contentType = "";
  const headers: Record<string, string> = {};
  if (options.lastEventId !== undefined) {
    headers["last-event-id"] = String(options.lastEventId);
  }
  const clientRequest = request(
    { protocol: url.protocol, hostname: url.hostname, port: url.port, path, method: "GET", headers },
    (response) => {
      contentType = String(response.headers["content-type"] ?? "");
      response.on("data", (chunk) => {
        buffer.raw += chunk.toString("utf8");
        parseSseChunk(buffer, frames);
      });
      response.on("end", () => undefined);
      response.on("error", () => undefined);
    }
  );
  clientRequest.on("error", () => undefined);
  clientRequest.end();
  return {
    frames,
    get contentType() {
      return contentType;
    },
    close() {
      clientRequest.destroy();
    }
  };
}

/** IDEA-D2 workspace frames arrive as `session.event` SSE frames wrapping a workspace.event timeline event. */
function workspaceFrames(reader: SseReader): WorkspaceFrameMetadata[] {
  return reader.frames
    .filter((frame) => frame.event === "session.event" && frame.data !== undefined)
    .map((frame) => JSON.parse(frame.data as string) as { event: { type: string; metadata: WorkspaceFrameMetadata } })
    .filter((payload) => payload.event.type === "workspace.event")
    .map((payload) => payload.event.metadata);
}

async function getJson(url: URL, path: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${url.origin}${path}`);
  const body = (await response.json()) as unknown;
  return { status: response.status, body };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) {
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }
}

async function withServer(run: (server: ApiServerHandle, url: URL) => Promise<void>): Promise<void> {
  const server = await startHarnessApiServer({ port: 0, host: "127.0.0.1" });
  try {
    await run(server, new URL(server.url));
  } finally {
    await server.close();
  }
}

describe("API workspace SSE attach signals (IDEA-D2)", () => {
  it("streams workspace events on /workspace/events as clients attach and detach", async () => {
    await withServer(async (_server, url) => {
      const reader = openEventStream(url, "/workspace/events");
      try {
        await waitFor(() => reader.frames.some((frame) => frame.event === "ready"), 2_000);
        expect(reader.contentType).toBe("text/event-stream; charset=utf-8");

        const stream = openEventStream(url, "/events");
        try {
          await waitFor(() => workspaceFrames(reader).some((frame) => frame.workspaceEventType === "workspace.attach"), 2_000);
          const attach = workspaceFrames(reader).find((frame) => frame.workspaceEventType === "workspace.attach");
          expect(attach).toMatchObject({
            workspaceKey: process.cwd(),
            attachedClients: 1,
            isBusy: false
          });

          stream.close();
          await waitFor(() => workspaceFrames(reader).some((frame) => frame.workspaceEventType === "workspace.detach"), 2_000);
          const detach = workspaceFrames(reader).find((frame) => frame.workspaceEventType === "workspace.detach");
          expect(detach?.attachedClients).toBe(0);
        } finally {
          stream.close();
        }
      } finally {
        reader.close();
      }
    });
  });

  it("tracks multiple attached clients on one workspace and replays to a cursor", async () => {
    await withServer(async (_server, url) => {
      const first = openEventStream(url, "/events");
      const second = openEventStream(url, "/events");
      try {
        await waitFor(() => first.frames.some((frame) => frame.event === "ready") && second.frames.some((frame) => frame.event === "ready"), 2_000);

        const workspaces = await getJson(url, "/workspaces");
        expect(workspaces.status).toBe(200);
        expect(workspaces.body).toMatchObject({
          route: "workspace-list",
          workspaces: [{ workspaceKey: process.cwd(), attachedClients: 2, isBusy: false }],
          count: 1
        });

        const replay = openEventStream(url, "/workspace/events", { lastEventId: 0 });
        try {
          await waitFor(() => workspaceFrames(replay).filter((frame) => frame.workspaceEventType === "workspace.attach").length === 2, 2_000);
          const attachFrames = workspaceFrames(replay).filter((frame) => frame.workspaceEventType === "workspace.attach");
          expect(attachFrames.at(-1)?.attachedClients).toBe(2);
        } finally {
          replay.close();
        }
      } finally {
        first.close();
        second.close();
      }
    });
  });

  it("reports the workspace busy signal on the workspace timeline stream", async () => {
    await withServer(async (_server, url) => {
      const workspaceEvents = openEventStream(url, "/workspace/events");
      try {
        await waitFor(() => workspaceEvents.frames.some((frame) => frame.event === "ready"), 2_000);

        const response = await fetch(`${url.origin}/session-start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        expect(response.status).toBe(200);
        const session = (await response.json()) as { id: string };

        await waitFor(() => workspaceFrames(workspaceEvents).some((frame) => frame.workspaceEventType === "session.started"), 2_000);
        const started = workspaceFrames(workspaceEvents).find((frame) => frame.workspaceEventType === "session.started");
        expect(started).toMatchObject({ workspaceKey: process.cwd(), isBusy: true, sessionId: session.id });

        const listing = await getJson(url, `/workspaces?cwd=${encodeURIComponent(process.cwd())}`);
        expect(listing.body).toMatchObject({ workspaces: [{ isBusy: true }] });
      } finally {
        workspaceEvents.close();
      }
    });
  });

  it("keeps the workspace stream read-only: POST is not a route", async () => {
    await withServer(async (_server, url) => {
      const response = await fetch(`${url.origin}/workspace/events`, { method: "POST" });
      expect(response.status).toBe(404);
      const workspacesPost = await fetch(`${url.origin}/workspaces`, { method: "POST" });
      expect(workspacesPost.status).toBe(404);
    });
  });

  it("lists workspace stream endpoints in health", async () => {
    await withServer(async (_server, url) => {
      const health = await getJson(url, "/health");
      const endpoints = (health.body as { endpoints: string[] }).endpoints;
      expect(endpoints).toContain("GET /workspaces");
      expect(endpoints).toContain("GET /workspace/events");
    });
  });
});
