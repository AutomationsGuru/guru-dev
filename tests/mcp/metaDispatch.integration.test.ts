import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { GURU_CHAT_TOOL_IDS, READ_ONLY_TOOL_IDS } from "../../src/guru.js";
import { evaluateToolMandate, MANDATE_READ_ONLY_TOOLS, verbsForCall } from "../../src/mandates/evaluate.js";
import type { MandateState } from "../../src/mandates/schema.js";
import { createInMemorySessionPersistenceStore } from "../../src/runtime/persistence.js";
import {
  createHarnessRuntime,
  type HarnessRuntime,
  type StartHarnessSessionOptions
} from "../../src/runtime/session.js";
import { findToolParityRow, getToolParityVerdictCounts } from "../../src/tools/toolParity.js";

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fakeMcpServer = resolve(fixtureDirectory, "fake-mcp-server.mjs");
const metaToolIds = ["search_tool", "use_tool"] as const;
const emptyMandate: MandateState = { grants: [], denies: [] };

const SearchOutputSchema = z
  .object({
    query: z.string(),
    tools: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          description: z.string()
        })
        .strict()
    )
  })
  .strict();

const InnerObservationSchema = z
  .object({
    toolId: z.string(),
    status: z.enum(["succeeded", "failed"]),
    startedAt: z.string(),
    endedAt: z.string(),
    durationMs: z.number().nonnegative(),
    output: z.unknown().optional(),
    error: z.string().optional()
  })
  .strict();

interface TestWorkspace {
  readonly root: string;
  readonly options: StartHarnessSessionOptions;
}

const runtimes = new Set<HarnessRuntime>();
const workspaceRoots = new Set<string>();

function trackRuntime(runtime: HarnessRuntime): HarnessRuntime {
  runtimes.add(runtime);
  return runtime;
}

function fakeMcpConfig(): Record<string, unknown> {
  return {
    id: "fake",
    transport: "stdio",
    command: process.execPath,
    args: [fakeMcpServer],
    category: "test",
    timeoutMs: 10_000
  };
}

async function createWorkspace(mcpServers: readonly Record<string, unknown>[] = []): Promise<TestWorkspace> {
  const root = await mkdtemp(resolve(tmpdir(), "g1005-meta-dispatch-integration-"));
  const projectDirectory = resolve(root, "project");
  const homeDirectory = resolve(root, "home");
  const configPath = resolve(root, "guruharness.config.json");
  workspaceRoots.add(root);
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers }), "utf8");

  return {
    root,
    options: {
      cwd: projectDirectory,
      purpose: "chat",
      guruHomeDirectory: homeDirectory,
      configPath
    }
  };
}

function registeredToolIds(runtime: HarnessRuntime, sessionId: string): readonly string[] {
  return runtime.getSessionTools(sessionId).map((tool) => tool.id);
}

function expectOneMetaDispatchPair(toolIds: readonly string[]): void {
  for (const toolId of metaToolIds) {
    expect(toolIds.filter((candidate) => candidate === toolId), `${toolId} registration count`).toHaveLength(1);
  }
}

afterEach(async () => {
  const liveRuntimes = [...runtimes];
  const roots = [...workspaceRoots];
  runtimes.clear();
  workspaceRoots.clear();
  await Promise.allSettled(liveRuntimes.map((runtime) => runtime.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("G1005 MCP meta-dispatch registration integration", () => {
  it("registers both meta tools exactly once without configured MCP", async () => {
    const workspace = await createWorkspace();
    const runtime = trackRuntime(createHarnessRuntime());
    const session = await runtime.startSession(workspace.options);

    expectOneMetaDispatchPair(registeredToolIds(runtime, session.id));
  });

  it("returns an empty search result without configured MCP", async () => {
    const workspace = await createWorkspace();
    const runtime = trackRuntime(createHarnessRuntime());
    const session = await runtime.startSession(workspace.options);

    const observation = await runtime.executeTool(session.id, "search_tool", { query: "anything" });

    expect(observation.status).toBe("succeeded");
    expect(SearchOutputSchema.parse(observation.output)).toEqual({ query: "anything", tools: [] });
  });

  it("keeps exactly one registration in independent sessions", async () => {
    const workspace = await createWorkspace();
    const runtime = trackRuntime(createHarnessRuntime());
    const first = await runtime.startSession(workspace.options);
    const second = await runtime.startSession(workspace.options);

    expectOneMetaDispatchPair(registeredToolIds(runtime, first.id));
    expectOneMetaDispatchPair(registeredToolIds(runtime, second.id));
  });

  it("searches only public metadata from attached MCP definitions", async () => {
    const workspace = await createWorkspace([fakeMcpConfig()]);
    const runtime = trackRuntime(createHarnessRuntime());
    const session = await runtime.startSession(workspace.options);
    expectOneMetaDispatchPair(registeredToolIds(runtime, session.id));

    const observation = await runtime.executeTool(session.id, "search_tool", { query: "echo" });
    const output = SearchOutputSchema.parse(observation.output);

    expect(observation.status).toBe("succeeded");
    expect(output.query).toBe("echo");
    expect(output.tools).toHaveLength(1);
    expect(output.tools[0]?.id).toBe("mcp.fake.echo");
    expect(Object.keys(output.tools[0] ?? {}).sort()).toEqual(["description", "id", "title"]);
  });

  it("returns an outer use_tool observation containing a sanitized inner observation", async () => {
    const workspace = await createWorkspace([fakeMcpConfig()]);
    const persistence = createInMemorySessionPersistenceStore();
    const runtime = trackRuntime(createHarnessRuntime({ sessionPersistenceStore: persistence }));
    const session = await runtime.startSession(workspace.options);

    const outer = await runtime.executeTool(session.id, "use_tool", {
      toolId: "mcp.fake.leak",
      arguments: {}
    });
    expect(outer).toMatchObject({ toolId: "use_tool", status: "succeeded" });
    const inner = InnerObservationSchema.parse(outer.output);
    const events = await runtime.listSessionEvents(session.id);
    const toolEvents = events.filter((event) => event.type === "tool.observation");

    expect(inner).toMatchObject({ toolId: "mcp.fake.leak", status: "succeeded" });
    expect(JSON.stringify(inner.output)).toContain("[redacted");
    expect(JSON.stringify(inner.output)).not.toContain("sk-fakeleak");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.payload).toEqual(outer);
  });

  it("keeps one registration when a session is resumed and rebuilt", async () => {
    const workspace = await createWorkspace([fakeMcpConfig()]);
    const persistence = createInMemorySessionPersistenceStore();
    const firstRuntime = trackRuntime(createHarnessRuntime({ sessionPersistenceStore: persistence }));
    const secondRuntime = trackRuntime(createHarnessRuntime({ sessionPersistenceStore: persistence }));
    const started = await firstRuntime.startSession(workspace.options);

    const resumed = await secondRuntime.resumeSession(started.id, workspace.options);
    expect(resumed).toBeDefined();
    expectOneMetaDispatchPair(registeredToolIds(secondRuntime, started.id));

    const rebuilt = await secondRuntime.resumeSession(started.id, workspace.options);
    expect(rebuilt).toBeDefined();
    expectOneMetaDispatchPair(registeredToolIds(secondRuntime, started.id));
  });

  it("exposes search_tool as read-only while use_tool remains write-gated", () => {
    expect(GURU_CHAT_TOOL_IDS.has("search_tool")).toBe(true);
    expect(GURU_CHAT_TOOL_IDS.has("use_tool")).toBe(true);
    expect(READ_ONLY_TOOL_IDS.has("search_tool")).toBe(true);
    expect(READ_ONLY_TOOL_IDS.has("use_tool")).toBe(false);
    expect(MANDATE_READ_ONLY_TOOLS.has("search_tool")).toBe(true);
    expect(MANDATE_READ_ONLY_TOOLS.has("use_tool")).toBe(false);
    expect(verbsForCall("search_tool", {})).toEqual([]);
    expect(verbsForCall("use_tool", { toolId: "mcp.fake.echo", arguments: {} })).toEqual(["write"]);
    expect(evaluateToolMandate("search_tool", {}, { cwd: "/work", state: emptyMandate, yolo: false }).outcome).toBe("allow");
    expect(evaluateToolMandate("use_tool", {}, { cwd: "/work", state: emptyMandate, yolo: false }).outcome).toBe("escalate");
  });

  it("blocks use_tool at the outer mandate boundary", async () => {
    const workspace = await createWorkspace([fakeMcpConfig()]);
    const denyWrites: MandateState = { grants: [], denies: [{ verb: "write" }] };
    const runtime = trackRuntime(
      createHarnessRuntime({
        mandatePolicy: (toolId, input, cwd) => evaluateToolMandate(toolId, input, { cwd, state: denyWrites, yolo: true })
      })
    );
    const session = await runtime.startSession(workspace.options);

    const search = await runtime.executeTool(session.id, "search_tool", { query: "echo" });
    const blocked = await runtime.executeTool(session.id, "use_tool", {
      toolId: "mcp.fake.echo",
      arguments: { value: "must-not-dispatch" }
    });

    expect(search.status).toBe("succeeded");
    expect(blocked).toMatchObject({
      toolId: "use_tool",
      status: "failed",
      error: expect.stringMatching(/Blocked by mandate.*write/iu)
    });
  });

  it("names meta tools in existing parity rows without changing verdict totals", () => {
    expect(findToolParityRow("mcp_list_tools")?.currentGuruHarnessToolIds).toContain("search_tool");
    expect(findToolParityRow("mcp_call_tool")?.currentGuruHarnessToolIds).toContain("use_tool");
    expect(getToolParityVerdictCounts()).toEqual({ GREEN: 23, YELLOW: 3, RED: 0 });
  });
});
