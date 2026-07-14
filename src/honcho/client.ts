import { Honcho } from "@honcho-ai/sdk";

import { detectPotentialSecrets } from "../safety/policyGuard.js";
import {
  HonchoConfigSchema,
  HonchoContextRequestSchema,
  HonchoContextSnapshotSchema,
  HonchoLogTurnRequestSchema,
  HonchoRecallRequestSchema,
  HonchoRecallResultSchema,
  HonchoRememberRequestSchema,
  HonchoStatusSchema,
  type HonchoConfig,
  type HonchoContextRequest,
  type HonchoContextSnapshot,
  type HonchoLogTurnRequest,
  type HonchoRecallRequest,
  type HonchoRecallResult,
  type HonchoRememberRequest,
  type HonchoStatus
} from "./schemas.js";

export interface HonchoMemoryEntry {
  readonly id: string;
  readonly peer: "user" | "ai";
  readonly summary: string;
  readonly createdAt: string;
}

export interface HonchoWriteResult {
  readonly status: "succeeded" | "blocked" | "failed";
  readonly id?: string;
  readonly summary: string;
}

export interface HonchoClient {
  /** A real readiness probe, not an env-name-only claim. */
  status(): Promise<HonchoStatus>;
  remember(request: HonchoRememberRequest): Promise<HonchoWriteResult>;
  recall(request: HonchoRecallRequest): Promise<HonchoRecallResult>;
  context(request: HonchoContextRequest): Promise<HonchoContextSnapshot>;
  logTurn(request: HonchoLogTurnRequest): Promise<HonchoWriteResult>;
}

export interface HonchoClientOptions {
  readonly config: HonchoConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly entries?: readonly HonchoMemoryEntry[];
  readonly now?: () => Date;
}

/**
 * The production adapter for Honcho's official SDK. It is inert unless explicitly
 * enabled in config. The configured API-key ENV NAME is the only credential
 * reference exposed by status; the value is passed directly to the SDK and never
 * returned or logged by this module.
 */
export function createHonchoClient(options: HonchoClientOptions): HonchoClient {
  const config = HonchoConfigSchema.parse(options.config);
  const env = options.env ?? process.env;
  let client: Honcho | null = null;

  const apiKey = (): string | null => {
    const candidate = env[config.apiKeyEnvVar];
    return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
  };

  const missingEnvNames = (): string[] => (apiKey() ? [] : [config.apiKeyEnvVar]);

  const getClient = (): Honcho | null => {
    if (client) {
      return client;
    }
    const key = apiKey();
    if (!key) {
      return null;
    }
    client = new Honcho({
      apiKey: key,
      workspaceId: config.workspaceId,
      timeout: config.timeoutMs,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
    });
    return client;
  };

  const getSession = async () => {
    const active = getClient();
    if (!active) {
      throw new Error("Honcho is missing its configured API key.");
    }
    const [user, agent] = await Promise.all([active.peer(config.userPeerId), active.peer(config.agentPeerId)]);
    const session = await active.session(config.sessionId, { peers: [user, agent] });
    return { user, agent, session };
  };

  return {
    async status() {
      if (!config.enabled) {
        return HonchoStatusSchema.parse({
          status: "disabled",
          workspaceId: config.workspaceId,
          sessionId: config.sessionId,
          writeEnabled: false,
          missingEnvNames: [],
          summary: "Honcho is disabled. Configure memory.honcho.enabled=true to connect it."
        });
      }
      const missing = missingEnvNames();
      if (missing.length > 0) {
        return HonchoStatusSchema.parse({
          status: "missing-env",
          workspaceId: config.workspaceId,
          sessionId: config.sessionId,
          writeEnabled: false,
          missingEnvNames: missing,
          summary: "Honcho is enabled but its API-key environment variable is missing."
        });
      }
      try {
        // This is a read-only authenticated API call. It verifies connectivity
        // without creating a workspace, session, peer, or memory entry.
        await within(getClient()!.workspaces({ size: 1 }), Math.min(config.timeoutMs, 3_000));
        return HonchoStatusSchema.parse({
          status: "ready",
          workspaceId: config.workspaceId,
          sessionId: config.sessionId,
          writeEnabled: true,
          missingEnvNames: [],
          summary: "Honcho is connected and ready for configured memory sync."
        });
      } catch {
        return HonchoStatusSchema.parse({
          status: "offline",
          workspaceId: config.workspaceId,
          sessionId: config.sessionId,
          writeEnabled: false,
          missingEnvNames: [],
          summary: "Honcho could not be reached. Check the configured endpoint, credentials, and network."
        });
      }
    },

    async remember(rawRequest) {
      const request = HonchoRememberRequestSchema.parse(rawRequest);
      const blockers = configuredWriteBlockers(config, apiKey(), request.fact, "fact");
      if (blockers.length > 0) {
        return { status: "blocked", summary: blockers.join(" ") };
      }
      try {
        const { user, agent, session } = await getSession();
        const peer = request.peer === "ai" ? agent : user;
        const content = request.context ? `${request.fact}\n\nContext: ${request.context}` : request.fact;
        const [message] = await session.addMessages(peer.message(content, { metadata: { source: "guru-memory-fact" } }));
        return { status: "succeeded", ...(message ? { id: message.id } : {}), summary: "Honcho memory fact stored." };
      } catch {
        return { status: "failed", summary: "Honcho could not store the memory fact. Check honcho_memory_status and try again." };
      }
    },

    async recall(rawRequest) {
      const request = HonchoRecallRequestSchema.parse(rawRequest);
      if (!config.enabled) {
        return HonchoRecallResultSchema.parse({ status: "blocked", items: [], summary: "Honcho is disabled. Enable it in memory.honcho configuration first." });
      }
      if (!apiKey()) {
        return HonchoRecallResultSchema.parse({ status: "blocked", items: [], summary: `Honcho is missing ${config.apiKeyEnvVar}.` });
      }
      try {
        const { session } = await getSession();
        const messages = await session.search(request.query, { limit: request.limit });
        const items = messages
          .filter((message) => !request.peer || peerKind(message.peerId, config) === request.peer)
          .map((message) => ({
            id: message.id,
            peer: peerKind(message.peerId, config),
            summary: summarize(message.content),
            confidence: 0.8,
            ...(request.includeRaw ? { raw: message.content } : {})
          }));
        return HonchoRecallResultSchema.parse({
          status: "succeeded",
          items,
          ...(request.reasoningLevel === "off" ? {} : { reasonedSummary: `${items.length} relevant Honcho message(s) matched.` }),
          summary: `Recalled ${items.length} Honcho memory item(s).`
        });
      } catch {
        return HonchoRecallResultSchema.parse({ status: "failed", items: [], summary: "Honcho recall failed. Check honcho_memory_status and try again." });
      }
    },

    async context(rawRequest) {
      const request = HonchoContextRequestSchema.parse(rawRequest);
      if (!config.enabled) {
        return HonchoContextSnapshotSchema.parse({ status: "blocked", snapshot: "Honcho is disabled.", tokenEstimate: 4, summary: "Enable Honcho in memory.honcho configuration first." });
      }
      if (!apiKey()) {
        return HonchoContextSnapshotSchema.parse({ status: "blocked", snapshot: "Honcho API key is not configured.", tokenEstimate: 8, summary: `Honcho is missing ${config.apiKeyEnvVar}.` });
      }
      try {
        const { user, agent, session } = await getSession();
        const perspective = request.peer === "user" ? user : agent;
        const target = request.peer === "ai" ? agent : user;
        const context = await session.context({
          tokens: request.maxTokens,
          peerPerspective: perspective,
          peerTarget: target,
          summary: true
        });
        const parts = [context.peerRepresentation, context.summary?.content].filter((part): part is string => Boolean(part && part.trim().length > 0));
        if (request.includeRaw) {
          parts.push(...context.messages.map((message) => `[${peerKind(message.peerId, config)}] ${message.content}`));
        }
        const snapshot = parts.join("\n\n").trim() || "No Honcho memory context available yet.";
        return HonchoContextSnapshotSchema.parse({
          status: "succeeded",
          snapshot,
          tokenEstimate: Math.ceil(snapshot.length / 4),
          summary: "Built a Honcho context snapshot."
        });
      } catch {
        return HonchoContextSnapshotSchema.parse({ status: "failed", snapshot: "Honcho context is temporarily unavailable.", tokenEstimate: 9, summary: "Honcho context request failed." });
      }
    },

    async logTurn(rawRequest) {
      const request = HonchoLogTurnRequestSchema.parse(rawRequest);
      const value = [request.userSummary, request.assistantSummary].filter(Boolean).join("\n");
      const blockers = configuredWriteBlockers(config, apiKey(), value, "turn summary");
      if (blockers.length > 0) {
        return { status: "blocked", summary: blockers.join(" ") };
      }
      try {
        const { user, agent, session } = await getSession();
        const messages = [user.message(request.userSummary, { metadata: { source: "guru-turn", role: "user" } })];
        if (request.assistantSummary) {
          messages.push(agent.message(request.assistantSummary, { metadata: { source: "guru-turn", role: "assistant" } }));
        }
        const created = await session.addMessages(messages);
        return { status: "succeeded", ...(created[0] ? { id: created[0].id } : {}), summary: "Honcho turn stored." };
      } catch {
        return { status: "failed", summary: "Honcho could not store the turn. Check honcho_memory_status and try again." };
      }
    }
  };
}

/**
 * Retained solely as a deterministic test double. Production wiring uses
 * createHonchoClient and never reports this in-memory adapter as a real service.
 */
export function createInMemoryHonchoClient(options: HonchoClientOptions): HonchoClient {
  const config = HonchoConfigSchema.parse(options.config);
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const entries: HonchoMemoryEntry[] = [...(options.entries ?? [])];

  return {
    async status() {
      const required = config.requiredEnvNames.length > 0 ? config.requiredEnvNames : config.enabled ? [config.apiKeyEnvVar] : [];
      const missingEnvNames = required.filter((name) => !env[name]);
      const status = missingEnvNames.length > 0 ? "missing-env" : config.writeEnabled ? "ready" : config.enabled ? "read-only" : "disabled";
      return HonchoStatusSchema.parse({
        status,
        workspaceId: config.workspaceId,
        sessionId: config.sessionId,
        writeEnabled: config.writeEnabled,
        missingEnvNames,
        summary:
          missingEnvNames.length > 0
            ? "Honcho test double is missing required environment variable name(s)."
            : config.writeEnabled
              ? "Honcho test double is write-enabled."
              : config.enabled
                ? "Honcho test double is available in read-only mode."
                : "Honcho is disabled."
      });
    },

    async remember(rawRequest) {
      const request = HonchoRememberRequestSchema.parse(rawRequest);
      const blockers = legacyWriteBlockers(config.writeEnabled, request.userApproved, request.fact, "fact");
      if (blockers.length > 0) {
        return { status: "blocked", summary: blockers.join(" ") };
      }
      const id = `honcho-${entries.length + 1}`;
      entries.push({ id, peer: request.peer, summary: request.context ? `${request.fact}\nContext: ${request.context}` : request.fact, createdAt: now().toISOString() });
      return { status: "succeeded", id, summary: "Honcho test memory fact stored." };
    },

    async recall(rawRequest) {
      const request = HonchoRecallRequestSchema.parse(rawRequest);
      const terms = request.query.toLowerCase().split(/\s+/u).filter(Boolean);
      const matches = entries
        .filter((entry) => !request.peer || entry.peer === request.peer)
        .filter((entry) => terms.some((term) => entry.summary.toLowerCase().includes(term)))
        .slice(0, request.limit)
        .map((entry) => ({ id: entry.id, peer: entry.peer, summary: entry.summary, confidence: 0.8, ...(request.includeRaw ? { raw: entry.summary } : {}) }));
      return HonchoRecallResultSchema.parse({ status: "succeeded", items: matches, ...(request.reasoningLevel === "off" ? {} : { reasonedSummary: `${matches.length} relevant memory item(s) matched.` }), summary: `Recalled ${matches.length} Honcho test memory item(s).` });
    },

    async context(rawRequest) {
      const request = HonchoContextRequestSchema.parse(rawRequest);
      const selected = entries.filter((entry) => !request.peer || entry.peer === request.peer);
      const snapshot = selected.map((entry) => `- [${entry.peer}] ${entry.summary}`).join("\n") || "No Honcho memory context available.";
      return HonchoContextSnapshotSchema.parse({ status: "succeeded", snapshot: request.includeRaw ? snapshot : snapshot.slice(0, request.maxTokens * 4), tokenEstimate: Math.ceil(snapshot.length / 4), summary: `Built Honcho test context snapshot from ${selected.length} item(s).` });
    },

    async logTurn(rawRequest) {
      const request = HonchoLogTurnRequestSchema.parse(rawRequest);
      const value = [request.userSummary, request.assistantSummary].filter(Boolean).join("\n");
      const blockers = legacyWriteBlockers(config.writeEnabled, request.userApproved, value, "turn summary");
      if (blockers.length > 0) {
        return { status: "blocked", summary: blockers.join(" ") };
      }
      const id = `honcho-${entries.length + 1}`;
      entries.push({ id, peer: request.peer, summary: value, createdAt: now().toISOString() });
      return { status: "succeeded", id, summary: "Honcho test turn stored." };
    }
  };
}

function configuredWriteBlockers(config: HonchoConfig, apiKey: string | null, value: string, name: string): string[] {
  const blockers: string[] = [];
  if (!config.enabled) {
    blockers.push("Honcho is disabled; enable memory.honcho before using it.");
  }
  if (!apiKey) {
    blockers.push(`Honcho requires ${config.apiKeyEnvVar}.`);
  }
  blockers.push(...detectPotentialSecrets([{ name, value }]).map((detection) => `Potential secret or sensitive value detected in ${detection.name} (${detection.kind}; value redacted).`));
  return blockers;
}

function legacyWriteBlockers(writeEnabled: boolean, userApproved: boolean, value: string, name: string): string[] {
  const blockers: string[] = [];
  if (!writeEnabled) blockers.push("Honcho write operation requires writeEnabled=true.");
  if (!userApproved) blockers.push("Honcho write operation requires userApproved=true.");
  blockers.push(...detectPotentialSecrets([{ name, value }]).map((detection) => `Potential secret or sensitive value detected in ${detection.name} (${detection.kind}; value redacted).`));
  return blockers;
}

function peerKind(peerId: string, config: HonchoConfig): "user" | "ai" {
  return peerId === config.agentPeerId ? "ai" : "user";
}

function summarize(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
}

/** Status belongs in the boot/UI path, so an offline optional service gets a short budget. */
function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Honcho status probe timed out.")), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
