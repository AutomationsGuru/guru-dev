import { z } from "zod";

import { loadHarnessConfig } from "../config/loadConfig.js";
import { createFileMemoryStore } from "../memory/store.js";
import { createMandateStore } from "../mandates/store.js";
import { isChatCapableFamily, resolveRouteCredential } from "../model/directChat.js";
import { createDirectProviderCatalog } from "../providers/catalog.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import { createHarnessRuntime, type HarnessRuntime, type HarnessRuntimeDependencies } from "../runtime/session.js";
import type { HarnessSession } from "../runtime/schemas.js";
import { scrubSecretValuesReport } from "../safety/secretSafety.js";
import { AgentSession } from "../session/agentSession.js";

const BoundedCountSchema = z.number().int().nonnegative().max(1_000_000);
const ReceiptStringSchema = z.string().max(1_000_000);
const RouteStringSchema = z.string().max(4_096);
const PatternNameSchema = z.string().min(1).max(128);
const ErrorStringSchema = z.string().min(1).max(16_384);
const MAX_ERROR_LENGTH = 16_384;

const ReceiptRouteSchema = z
  .object({
    routeId: RouteStringSchema,
    modelId: RouteStringSchema,
    apiFamily: RouteStringSchema
  })
  .strict();

const ReceiptUsageSchema = z
  .object({
    turns: BoundedCountSchema,
    inputTokens: BoundedCountSchema,
    outputTokens: BoundedCountSchema,
    contextWindowTokens: BoundedCountSchema
  })
  .strict();

const ReceiptFields = {
  route: ReceiptRouteSchema,
  text: ReceiptStringSchema,
  toolCalls: BoundedCountSchema,
  usage: ReceiptUsageSchema,
  sanitizedPatterns: z.array(PatternNameSchema).max(64)
} as const;

export const PrintReceiptSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      ...ReceiptFields
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      ...ReceiptFields,
      error: ErrorStringSchema
    })
    .strict()
]);

export type PrintReceipt = z.infer<typeof PrintReceiptSchema>;

export interface RunPrintOptions {
  readonly prompt: string;
  /** Inject a session (tests); otherwise a session is bootstrapped from the catalog. */
  readonly session?: AgentSession;
  /** Construct the runtime print mode owns when it bootstraps a session. */
  readonly createRuntime?: (dependencies?: HarnessRuntimeDependencies) => HarnessRuntime;
  /** Active harness-config loader; injectable for deterministic bootstrap tests. */
  readonly loadConfig?: typeof loadHarnessConfig;
  /** Optional deterministic route catalog; production uses createDirectProviderCatalog. */
  readonly routes?: readonly ProviderRouteDescriptor[];
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
  suppliedRoutes?: readonly ProviderRouteDescriptor[]
): Promise<{ readonly session: AgentSession; readonly runtime: HarnessRuntime }> {
  const runtime = createRuntime();
  try {
    const config = loadConfig().config;
    const routes = suppliedRoutes ?? createDirectProviderCatalog();
    const route =
      routes.find(
        (candidate) =>
          isChatCapableFamily(candidate.apiFamily) &&
          candidate.routeType === "direct-api" &&
          resolveRouteCredential(candidate).usable
      ) ?? routes[0];
    if (!route) {
      throw new Error("Print mode could not find a provider route.");
    }
    const harness = await runtime.startSession({ purpose: "chat" });
    try {
      return {
        session: createAgentSession(runtime, route, harness, config.compaction),
        runtime
      };
    } catch (error) {
      await runtime.closeSession(harness.id);
      throw error;
    }
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

function receiptRoute(session: AgentSession | undefined): PrintReceipt["route"] {
  const route = session?.activeRoute;
  return {
    routeId: route?.routeId ?? "",
    modelId: route?.modelId ?? "",
    apiFamily: route?.apiFamily ?? ""
  };
}

function uniquePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns)];
}

/** Run one prompt through AgentSession and emit one bounded, secret-scrubbed JSON receipt. */
export async function runPrintMode(options: RunPrintOptions): Promise<void> {
  const output = options.output ?? process.stdout;
  let session = options.session;
  let ownedRuntime: HarnessRuntime | undefined;
  let receipt: PrintReceipt;

  try {
    try {
      if (!session) {
        const boot = await bootstrapSession(
          options.createRuntime ?? createHarnessRuntime,
          options.loadConfig ?? loadHarnessConfig,
          options.routes
        );
        session = boot.session;
        ownedRuntime = boot.runtime;
      }

      const result = await session.promptDrainingFollowUps(options.prompt);
      const scrubbed = scrubSecretValuesReport(result.text);
      const stats = session.stats();
      receipt = PrintReceiptSchema.parse({
        ok: true,
        route: receiptRoute(session),
        text: scrubbed.text,
        toolCalls: result.toolCallCount,
        usage: {
          turns: stats.turns,
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          contextWindowTokens: stats.contextWindowTokens
        },
        sanitizedPatterns: uniquePatterns(scrubbed.matched)
      });
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error);
      const scrubbed = scrubSecretValuesReport(rawError.length > 0 ? rawError : "Print mode failed.");
      receipt = PrintReceiptSchema.parse({
        ok: false,
        route: receiptRoute(session),
        text: "",
        toolCalls: 0,
        usage: {
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          contextWindowTokens: 0
        },
        sanitizedPatterns: uniquePatterns(scrubbed.matched),
        error: scrubbed.text.slice(0, MAX_ERROR_LENGTH) || "Print mode failed."
      });
    }

    output.write(`${JSON.stringify(PrintReceiptSchema.parse(receipt))}\n`);
  } finally {
    await ownedRuntime?.close();
  }
}
