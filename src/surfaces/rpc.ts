import { StringDecoder } from "node:string_decoder";

import { z } from "zod";

import { AgentSession } from "../session/agentSession.js";
import { onSecretSanitized } from "../safety/secretSafety.js";
import { createHarnessRuntime } from "../runtime/session.js";
import { createDirectProviderCatalog } from "../providers/catalog.js";
import { createMandateStore } from "../mandates/store.js";
import { createFileMemoryStore } from "../memory/store.js";
import { isChatCapableFamily, resolveRouteCredential } from "../model/directChat.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * The RPC surface (RPC wave, ADR 2026-07-05-rpc-surface, THERE v2 §14 + §17
 * scenario 13). LF-delimited JSONL over stdio, framed with a StringDecoder —
 * NEVER `readline`, whose line splitting also breaks on U+2028/U+2029 and would
 * corrupt payloads. It drives the ONE unified AgentSession engine (the same
 * `driveTurn` the TUI uses — no second turn loop), and streams the engine's
 * typed events plus the `secret_sanitized` signal (pattern names only, §17.9).
 */

export const RpcRequestSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().trim().min(1),
    params: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export type RpcEmit = (message: Record<string, unknown>) => void;

export interface RpcContext {
  readonly session: AgentSession;
  readonly emit: RpcEmit;
  readonly routes?: readonly ProviderRouteDescriptor[];
}

/**
 * Frame LF-delimited lines out of a byte/string stream. Multi-byte UTF-8 is held
 * across chunk boundaries by the StringDecoder; U+2028/U+2029 inside a payload
 * are ordinary characters (only `\n` frames), so JSON is never corrupted.
 */
export function frameChunk(state: { buffer: string }, chunk: Buffer | string, decoder: StringDecoder): string[] {
  state.buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
  const lines: string[] = [];
  let index = state.buffer.indexOf("\n");
  while (index >= 0) {
    lines.push(state.buffer.slice(0, index));
    state.buffer = state.buffer.slice(index + 1);
    index = state.buffer.indexOf("\n");
  }
  return lines;
}

/** Handle one request → a response object. Events stream via ctx.emit during the call. */
export async function dispatchRpc(request: RpcRequest, ctx: RpcContext): Promise<Record<string, unknown>> {
  const params = request.params;
  const idField = request.id !== undefined ? { id: request.id } : {};
  try {
    switch (request.method) {
      case "prompt": {
        const result = await ctx.session.promptDrainingFollowUps(String(params.text ?? ""));
        return { ...idField, ok: true, result: { text: result.text, toolCalls: result.toolCallCount } };
      }
      case "steer": {
        ctx.session.steer(String(params.text ?? ""));
        return { ...idField, ok: true, result: { queued: ctx.session.queueDepth() } };
      }
      case "follow_up": {
        ctx.session.followUp(String(params.text ?? ""));
        return { ...idField, ok: true, result: { queued: ctx.session.queueDepth() } };
      }
      case "abort": {
        // §17 S13: really interrupt the running turn (trips the in-flight abort signal).
        const aborted = ctx.session.abort();
        return { ...idField, ok: true, result: { aborted } };
      }
      case "state":
      case "stats":
        return { ...idField, ok: true, result: ctx.session.stats() };
      case "suit_up": {
        const worn = ctx.session.suitUp(String(params.description ?? ""));
        return { ...idField, ok: true, result: { created: worn.created, suit: worn.suit?.slug ?? null, skippedRed: worn.skippedRed } };
      }
      case "park": {
        const receipt = ctx.session.park();
        return { ...idField, ok: true, result: receipt ?? { parked: false } };
      }
      case "models":
        return { ...idField, ok: true, result: (ctx.routes ?? []).map((route) => route.routeId) };
      default:
        return { ...idField, ok: false, error: `unknown method: ${request.method}` };
    }
  } catch (error) {
    return { ...idField, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Subscribe the emitter to the engine's typed events + the secret_sanitized signal. */
export function wireRpcEvents(session: AgentSession, emit: RpcEmit): () => void {
  const unsubs = [
    session.subscribe("turn.start", (p) => emit({ type: "event", event: "turn.start", text: p.text })),
    session.subscribe("token", (p) => emit({ type: "event", event: "token", chunk: p.chunk })),
    session.subscribe("tool.observation", (e) => emit({ type: "event", event: "tool.observation", toolId: e.toolId, status: e.status })),
    session.subscribe("turn.stop", (p) => emit({ type: "event", event: "turn.stop", toolCalls: p.toolCallCount })),
    session.subscribe("done.packet", (p) => emit({ type: "event", event: "done.packet", turns: p.turns })),
    session.subscribe("steer.injected", (p) => emit({ type: "event", event: "steer.injected", kind: p.kind })),
    session.subscribe("aborted", (p) => emit({ type: "event", event: "aborted", atTurn: p.atTurn })),
    // The secret_sanitized event carries pattern NAMES only, never a value (§17.9).
    onSecretSanitized((patterns) => emit({ type: "event", event: "secret_sanitized", patterns: [...patterns] }))
  ];
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

export interface RunRpcOptions {
  /** Inject a session (tests); otherwise a session is bootstrapped from the catalog. */
  readonly session?: AgentSession;
  readonly routes?: readonly ProviderRouteDescriptor[];
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

async function bootstrapSession(): Promise<{ session: AgentSession; routes: readonly ProviderRouteDescriptor[] }> {
  const runtime = createHarnessRuntime();
  const harness = await runtime.startSession({});
  const routes = createDirectProviderCatalog();
  const route = routes.find((r) => isChatCapableFamily(r.apiFamily) && r.routeType === "direct-api" && resolveRouteCredential(r).usable) ?? routes[0];
  const session = new AgentSession({
    runtime,
    route: route as ProviderRouteDescriptor,
    session: harness,
    sessionTools: runtime.getSessionTools(harness.id),
    mandate: createMandateStore().load(),
    memory: createFileMemoryStore(),
    now: () => new Date()
  });
  return { session, routes };
}

/** Run RPC mode: frame JSONL from stdin, dispatch on the unified engine, stream events. */
export async function runRpcMode(options: RunRpcOptions = {}): Promise<void> {
  const output = options.output ?? process.stdout;
  const emit: RpcEmit = (message) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  let session = options.session;
  let routes = options.routes;
  if (!session) {
    const boot = await bootstrapSession();
    session = boot.session;
    routes = boot.routes;
  }
  const ctx: RpcContext = { session, emit, ...(routes ? { routes } : {}) };
  const unwire = wireRpcEvents(session, emit);
  emit({ type: "event", event: "ready", methods: ["prompt", "steer", "follow_up", "abort", "state", "suit_up", "park", "models"] });

  const input = options.input ?? process.stdin;
  const decoder = new StringDecoder("utf8");
  const state = { buffer: "" };
  // Prompts serialize (each may drain follow-ups); steer/follow_up/abort stay immediate
  // so they can land mid-turn without waiting behind a long prompt.
  let promptChain: Promise<void> = Promise.resolve();
  const dispatchLine = (request: RpcRequest): void => {
    if (request.method === "prompt") {
      promptChain = promptChain.then(async () => {
        emit(await dispatchRpc(request, ctx));
      });
      return;
    }
    void dispatchRpc(request, ctx).then((response) => emit(response));
  };
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      void promptChain.finally(() => resolve());
    };
    input.on("data", (chunk: Buffer | string) => {
      for (const line of frameChunk(state, chunk, decoder)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        let request: RpcRequest;
        try {
          request = RpcRequestSchema.parse(JSON.parse(trimmed));
        } catch (error) {
          emit({ ok: false, error: `bad request: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
        dispatchLine(request);
      }
    });
    input.on("end", finish);
    input.on("close", finish);
  });
  unwire();
}
