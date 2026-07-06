import {
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
import { detectPotentialSecrets } from "../safety/policyGuard.js";

export interface HonchoMemoryEntry {
  readonly id: string;
  readonly peer: "user" | "ai";
  readonly summary: string;
  readonly createdAt: string;
}

export interface HonchoClient {
  status(): HonchoStatus;
  remember(request: HonchoRememberRequest): Promise<{ readonly status: "succeeded" | "blocked"; readonly id?: string; readonly summary: string }>;
  recall(request: HonchoRecallRequest): Promise<HonchoRecallResult>;
  context(request: HonchoContextRequest): Promise<HonchoContextSnapshot>;
  logTurn(request: HonchoLogTurnRequest): Promise<{ readonly status: "succeeded" | "blocked"; readonly id?: string; readonly summary: string }>;
}

export interface HonchoClientOptions {
  readonly config: HonchoConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly entries?: readonly HonchoMemoryEntry[];
  readonly now?: () => Date;
}

export function createInMemoryHonchoClient(options: HonchoClientOptions): HonchoClient {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const entries: HonchoMemoryEntry[] = [...(options.entries ?? [])];

  return {
    status() {
      const missingEnvNames = options.config.requiredEnvNames.filter((name) => !env[name]);
      const status = missingEnvNames.length > 0 ? "missing-env" : options.config.writeEnabled ? "ready" : "read-only";
      return HonchoStatusSchema.parse({
        status,
        workspaceId: options.config.workspaceId,
        ...(options.config.sessionId ? { sessionId: options.config.sessionId } : {}),
        writeEnabled: options.config.writeEnabled,
        missingEnvNames,
        summary: missingEnvNames.length > 0 ? "Honcho is missing required environment variable name(s)." : options.config.writeEnabled ? "Honcho memory is write-enabled." : "Honcho memory is available in read-only mode."
      });
    },
    async remember(rawRequest) {
      const request = HonchoRememberRequestSchema.parse(rawRequest);
      const blockers = writeBlockers(request.writeEnabled, request.userApproved, request.fact, "fact");
      if (blockers.length > 0) {
        return { status: "blocked", summary: blockers.join(" ") };
      }
      const id = `honcho-${entries.length + 1}`;
      entries.push({ id, peer: request.peer, summary: request.context ? `${request.fact}\nContext: ${request.context}` : request.fact, createdAt: now().toISOString() });
      return { status: "succeeded", id, summary: "Honcho memory fact stored." };
    },
    async recall(rawRequest) {
      const request = HonchoRecallRequestSchema.parse(rawRequest);
      const terms = request.query.toLowerCase().split(/\s+/u).filter(Boolean);
      const matches = entries
        .filter((entry) => !request.peer || entry.peer === request.peer)
        .filter((entry) => terms.some((term) => entry.summary.toLowerCase().includes(term)))
        .slice(0, request.limit)
        .map((entry) => ({ id: entry.id, peer: entry.peer, summary: entry.summary, confidence: 0.8, ...(request.includeRaw ? { raw: entry.summary } : {}) }));
      return HonchoRecallResultSchema.parse({ status: "succeeded", items: matches, reasonedSummary: request.reasoningLevel === "off" ? undefined : `${matches.length} relevant memory item(s) matched.`, summary: `Recalled ${matches.length} Honcho memory item(s).` });
    },
    async context(rawRequest) {
      const request = HonchoContextRequestSchema.parse(rawRequest);
      const selected = entries.filter((entry) => !request.peer || entry.peer === request.peer);
      const snapshot = selected.map((entry) => `- [${entry.peer}] ${entry.summary}`).join("\n") || "No Honcho memory context available.";
      return HonchoContextSnapshotSchema.parse({ status: "succeeded", snapshot: request.includeRaw ? snapshot : snapshot.slice(0, request.maxTokens * 4), tokenEstimate: Math.ceil(snapshot.length / 4), summary: `Built Honcho context snapshot from ${selected.length} item(s).` });
    },
    async logTurn(rawRequest) {
      const request = HonchoLogTurnRequestSchema.parse(rawRequest);
      const value = [request.userSummary, request.assistantSummary].filter(Boolean).join("\n");
      const blockers = writeBlockers(request.writeEnabled, request.userApproved, value, "turn summary");
      if (blockers.length > 0) return { status: "blocked", summary: blockers.join(" ") };
      const id = `honcho-${entries.length + 1}`;
      entries.push({ id, peer: request.peer, summary: value, createdAt: now().toISOString() });
      return { status: "succeeded", id, summary: "Honcho turn summary logged." };
    }
  };
}

function writeBlockers(writeEnabled: boolean, userApproved: boolean, value: string, name: string): string[] {
  const blockers: string[] = [];
  if (!writeEnabled) blockers.push("Honcho write operation requires writeEnabled=true.");
  if (!userApproved) blockers.push("Honcho write operation requires userApproved=true.");
  const detections = detectPotentialSecrets([{ name, value }]);
  blockers.push(...detections.map((detection) => `Potential secret or sensitive value detected in ${detection.name} (${detection.kind}; value redacted).`));
  return blockers;
}
