import { StringDecoder } from "node:string_decoder";

import { z } from "zod";

import { AgentSession } from "../session/agentSession.js";
import { onSecretSanitized } from "../safety/secretSafety.js";
import { createHarnessRuntime, type HarnessRuntime, type HarnessRuntimeDependencies } from "../runtime/session.js";
import type { HarnessSession } from "../runtime/schemas.js";
import { createDirectProviderCatalog } from "../providers/catalog.js";
import { createMandateStore } from "../mandates/store.js";
import { createFileMemoryStore } from "../memory/store.js";
import { isChatCapableFamily, resolveRouteCredential } from "../model/directChat.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import { loadHarnessConfig } from "../config/loadConfig.js";
import {
  createRpcSessionGraph,
  type RpcForkSessionFactory,
  type RpcSessionGraph
} from "./rpcSessionGraph.js";
import {
  createOperatorQuestionBroker,
  type OperatorQuestionBroker
} from "./operatorQuestionBroker.js";

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
  /** Optional graph keeps existing fixed-session dispatch callers compatible. */
  readonly graph?: RpcSessionGraph;
  readonly emit: RpcEmit;
  readonly routes?: readonly ProviderRouteDescriptor[];
  readonly operatorQuestions?: OperatorQuestionBroker;
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
    const session = ctx.graph?.activeSession ?? ctx.session;
    switch (request.method) {
      case "prompt": {
        const runPrompt = (activeSession: AgentSession) => activeSession.promptDrainingFollowUps(String(params.text ?? ""));
        const result = ctx.graph
          ? await ctx.graph.withActiveTurn(runPrompt)
          : await runPrompt(session);
        return { ...idField, ok: true, result: { text: result.text, toolCalls: result.toolCallCount } };
      }
      case "steer": {
        session.steer(String(params.text ?? ""));
        return { ...idField, ok: true, result: { queued: session.queueDepth() } };
      }
      case "follow_up": {
        session.followUp(String(params.text ?? ""));
        return { ...idField, ok: true, result: { queued: session.queueDepth() } };
      }
      case "abort": {
        // §17 S13: really interrupt the running turn (trips the in-flight abort signal).
        const aborted = session.abort();
        return { ...idField, ok: true, result: { aborted } };
      }
      case "compaction": {
        const instructions = typeof params.instructions === "string" ? params.instructions : undefined;
        const result = await session.compact(instructions);
        return { ...idField, ok: true, result };
      }
      case "state":
      case "stats":
        return { ...idField, ok: true, result: session.stats() };
      case "suit_up": {
        const worn = session.suitUp(String(params.description ?? ""));
        return { ...idField, ok: true, result: { created: worn.created, suit: worn.suit?.slug ?? null, skippedRed: worn.skippedRed } };
      }
      case "park": {
        const receipt = session.park();
        return { ...idField, ok: true, result: receipt ?? { parked: false } };
      }
      case "operator.answer": {
        const questionId = String(params.questionId ?? "");
        if (questionId.length === 0) return { ...idField, ok: false, error: "questionId required" };
        if (ctx.operatorQuestions) {
          const result = ctx.operatorQuestions.answer(questionId, params.answers as string[][]);
          if (!result.ok) return { ...idField, ok: false, error: result.error };
          return { ...idField, ok: true, result: { questionId } };
        }
        if (!session.hasAnswerHandler()) return { ...idField, ok: false, error: "No answer handler wired" };
        try {
          const answer = await session.dispatchAnswer(questionId);
          return { ...idField, ok: true, result: { questionId, answer } };
        } catch (error) {
          return { ...idField, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "models":
        return { ...idField, ok: true, result: (ctx.routes ?? []).map((route) => route.routeId) };
      case "get_available_models":
        return {
          ...idField,
          ok: true,
          result: (ctx.routes ?? []).map((route) => ({
            providerId: route.providerId,
            routeId: route.routeId,
            modelId: route.modelId,
            apiFamily: route.apiFamily ?? null,
            chatCapable: isChatCapableFamily(route.apiFamily),
            usable: resolveRouteCredential(route).usable,
            active: route.routeId === session.activeRoute.routeId
          }))
        };
      case "set_model": {
        const routeId = params.routeId;
        if (routeId === undefined || routeId === "") {
          return { ...idField, ok: false, error: "set_model: routeId is required." };
        }
        if (typeof routeId !== "string") {
          return { ...idField, ok: false, error: "set_model: routeId must be a string." };
        }
        const route = (ctx.routes ?? []).find((candidate) => candidate.routeId === routeId);
        if (!route) {
          return { ...idField, ok: false, error: `set_model: unknown route '${routeId}'.` };
        }
        if (!isChatCapableFamily(route.apiFamily)) {
          return { ...idField, ok: false, error: `set_model: route '${routeId}' is not chat-capable.` };
        }
        if (!resolveRouteCredential(route).usable) {
          return { ...idField, ok: false, error: `set_model: route '${routeId}' is not usable with the current credential resolution.` };
        }
        return { ...idField, ok: true, result: session.switchRoute(route) };
      }
      case "get_tree": {
        if (!ctx.graph) {
          throw new Error("RPC session graph: graph is unavailable.");
        }
        return { ...idField, ok: true, result: ctx.graph.tree() };
      }
      case "fork": {
        if (!ctx.graph) {
          throw new Error("RPC session graph: graph is unavailable.");
        }
        if (typeof params.throughHistoryIndex !== "number") {
          throw new Error("RPC session graph: throughHistoryIndex must identify an existing user message.");
        }
        const parentSessionId = params.sessionId;
        if (parentSessionId !== undefined && (typeof parentSessionId !== "string" || parentSessionId.trim().length === 0)) {
          throw new Error("RPC session graph: sessionId must be a non-empty string.");
        }
        const result = await ctx.graph.fork({
          ...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
          throughHistoryIndex: params.throughHistoryIndex
        });
        return { ...idField, ok: true, result };
      }
      case "switch_session": {
        if (!ctx.graph) {
          throw new Error("RPC session graph: graph is unavailable.");
        }
        if (typeof params.sessionId !== "string" || params.sessionId.trim().length === 0) {
          throw new Error("RPC session graph: sessionId must be a non-empty string.");
        }
        return { ...idField, ok: true, result: ctx.graph.switchSession(params.sessionId) };
      }
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
    session.subscribe("compaction.start", (p) => emit({
      type: "event",
      event: "compaction_start",
      reason: p.reason,
      beforeTokens: p.beforeTokens,
      historyLength: p.historyLength
    })),
    session.subscribe("compaction.end", (p) => {
      if (p.compacted) {
        emit({
          type: "event",
          event: "compaction_end",
          compacted: true,
          summaryCount: p.summaryCount,
          beforeTokens: p.beforeTokens,
          afterTokens: p.afterTokens
        });
        return;
      }
      emit({ type: "event", event: "compaction_end", compacted: false, reason: p.reason });
    }),
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
  /** Stable graph id for an injected root session. Defaults to `root`. */
  readonly rootSessionId?: string;
  /** Explicit branch factory for injected-session tests. */
  readonly createForkSession?: RpcForkSessionFactory;
  /** Construct the runtime RPC will own when it bootstraps a session. Ignored for an injected session. */
  readonly createRuntime?: (dependencies?: HarnessRuntimeDependencies) => HarnessRuntime;
  /** Active harness-config loader; injectable for deterministic bootstrap tests. */
  readonly loadConfig?: typeof loadHarnessConfig;
  readonly routes?: readonly ProviderRouteDescriptor[];
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

function createAgentSession(
  runtime: HarnessRuntime,
  route: ProviderRouteDescriptor,
  harness: HarnessSession,
  compaction: ReturnType<typeof loadHarnessConfig>["config"]["compaction"]
): AgentSession {
  return new AgentSession({
    runtime,
    route,
    session: harness,
    sessionTools: runtime.getSessionTools(harness.id),
    mandate: createMandateStore().load(),
    memory: createFileMemoryStore(),
    compaction,
    now: () => new Date()
  });
}

async function bootstrapSession(
  createRuntime: (dependencies?: HarnessRuntimeDependencies) => HarnessRuntime,
  loadConfig: typeof loadHarnessConfig,
  operatorQuestions: OperatorQuestionBroker
): Promise<{
  session: AgentSession;
  rootSessionId: string;
  createForkSession: RpcForkSessionFactory;
  routes: readonly ProviderRouteDescriptor[];
  runtime: HarnessRuntime;
}> {
  const runtime = createRuntime({
    interactiveCallbacks: {
      askQuestion: (questions, { sessionId }) => operatorQuestions.ask(sessionId, questions)
    }
  });
  try {
    const config = loadConfig().config;
    const routes = createDirectProviderCatalog();
    const route = routes.find((r) => isChatCapableFamily(r.apiFamily) && r.routeType === "direct-api" && resolveRouteCredential(r).usable) ?? routes[0];
    const selectedRoute = route as ProviderRouteDescriptor;
    const createForkSession: RpcForkSessionFactory = async () => {
      const harness = await runtime.startSession({ purpose: "chat" });
      try {
        return {
          sessionId: harness.id,
          session: createAgentSession(runtime, selectedRoute, harness, config.compaction),
          close: async () => {
            await runtime.closeSession(harness.id);
          }
        };
      } catch (error) {
        await runtime.closeSession(harness.id);
        throw error;
      }
    };
    const root = await createForkSession();
    return {
      session: root.session,
      rootSessionId: root.sessionId,
      createForkSession,
      routes,
      runtime
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

/** Run RPC mode: frame JSONL from stdin, dispatch on the unified engine, stream events. */
export async function runRpcMode(options: RunRpcOptions = {}): Promise<void> {
  const output = options.output ?? process.stdout;
  const emit: RpcEmit = (message) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  let session = options.session;
  let rootSessionId = options.rootSessionId ?? "root";
  let createForkSession = options.createForkSession;
  let routes = options.routes;
  let ownedRuntime: HarnessRuntime | undefined;
  const operatorQuestions = session ? undefined : createOperatorQuestionBroker();
  if (!session) {
    const boot = await bootstrapSession(
      options.createRuntime ?? createHarnessRuntime,
      options.loadConfig ?? loadHarnessConfig,
      operatorQuestions!
    );
    session = boot.session;
    rootSessionId = boot.rootSessionId;
    createForkSession = boot.createForkSession;
    routes = boot.routes;
    ownedRuntime = boot.runtime;
  }
  const liveSessions = new Set<AgentSession>([session]);
  const trackedForkSession = createForkSession
    ? async () => {
        const created = await createForkSession!();
        liveSessions.add(created.session);
        return created;
      }
    : undefined;
  const graph = createRpcSessionGraph({
    rootSessionId,
    rootSession: session,
    ...(trackedForkSession ? { createForkSession: trackedForkSession } : {})
  });
  const ctx: RpcContext = {
    session,
    graph,
    emit,
    ...(routes ? { routes } : {}),
    ...(operatorQuestions ? { operatorQuestions } : {})
  };
  let unwire = wireRpcEvents(session, emit);
  const unsubscribeOperatorQuestions = operatorQuestions?.onQuestion((record) => {
    emit({
      type: "event",
      event: "operator.question",
      questionId: record.questionId,
      sessionId: record.sessionId,
      questions: record.questions
    });
  });
  const unsubscribeActiveSession = graph.subscribeActiveSession((_sessionId, activeSession) => {
    unwire();
    unwire = wireRpcEvents(activeSession, emit);
  });
  const closePendingQuestions = (): void => {
    for (const liveSession of liveSessions) {
      try {
        liveSession.closeQuestions();
      } catch {
        // best-effort — never block shutdown
      }
    }
    operatorQuestions?.close();
  };
  try {
    emit({
      type: "event",
      event: "ready",
      methods: [
        "prompt",
        "steer",
        "follow_up",
        "abort",
        "state",
        "suit_up",
        "park",
        "models",
        ...(operatorQuestions || session.hasAnswerHandler() ? ["operator.answer"] : []),
        "compaction",
        "get_tree",
        "fork",
        "switch_session",
        "get_available_models",
        "set_model"
      ]
    });

    const input = options.input ?? process.stdin;
    const decoder = new StringDecoder("utf8");
    const state = { buffer: "" };
    // Prompts serialize (each may drain follow-ups), and set_model observes that
    // same accepted-input order so a later switch cannot change an earlier turn.
    // steer/follow_up/abort stay immediate so they can land mid-turn.
    let orderedChain: Promise<void> = Promise.resolve();
    const pendingDispatches = new Set<Promise<void>>();
    const dispatchLine = (request: RpcRequest): void => {
      if (request.method === "prompt" || request.method === "set_model") {
        // Chain route-sensitive requests serially, but catch at each link
        // (review 2026-07-08): the old chain had no .catch, so a single emit failure
        // (broken pipe, closed sink) rejected the shared promise and EVERY subsequent
        // prompt was silently swallowed for the rest of the session. Reset the chain
        // on failure so one bad write can't permanently kill the prompt stream.
        orderedChain = orderedChain
          .then(async () => {
            emit(await dispatchRpc(request, ctx));
          })
          .catch((error: unknown) => {
            // eslint-disable-next-line no-console
            console.warn(`[rpc] ordered ${request.method}: emit failed (${error instanceof Error ? error.message : String(error)}). Continuing.`);
          });
        return;
      }
      const pending = dispatchRpc(request, ctx).then((response) => emit(response)).catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[rpc] ${request.method}: emit failed (${error instanceof Error ? error.message : String(error)}).`);
      });
      pendingDispatches.add(pending);
      void pending.finally(() => {
        pendingDispatches.delete(pending);
      });
    };
    await new Promise<void>((resolve) => {
      let finishing = false;
      const finish = (): void => {
        if (finishing) return;
        finishing = true;
        // A prompt may itself be waiting on ask_question/waitForAnswer. Close
        // those waiters before awaiting the prompt chain or EOF can deadlock.
        closePendingQuestions();
        void orderedChain.then(async () => {
          await Promise.allSettled([...pendingDispatches]);
          resolve();
        });
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
  } finally {
    closePendingQuestions();
    unsubscribeOperatorQuestions?.();
    unsubscribeActiveSession();
    unwire();
    await ownedRuntime?.close();
  }
}
