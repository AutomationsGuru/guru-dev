import { resolve } from "node:path";

import {
  ExpansionDecisionSchema,
  ExpansionNeedSchema,
  SandboxDenialSignalSchema,
  SandboxExpansionHintSchema,
  type ExpansionDecision,
  type ExpansionNeed,
  type SandboxDenialSignal,
  type SandboxExpansionHint
} from "./sandboxExpansionSchema.js";

const PATH_DENIAL_PATTERN = /(permission denied|operation not permitted|access denied|sandbox denied|requires additional path access)/i;
const NETWORK_DENIAL_PATTERN = /(network is disabled|network access denied|socket access blocked|dns access denied|requires network access)/i;

export interface SandboxSessionLike {
  readonly sandbox: {
    readonly mode: "read-only" | "workspace-write";
    readonly allowPaths: readonly string[];
    readonly network: boolean;
  };
}

export interface DetectNeedInput {
  readonly denial?: SandboxDenialSignal;
  readonly hint?: SandboxExpansionHint;
}

export interface SandboxExpansionPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type SandboxExpansionPolicy<TSession extends SandboxSessionLike = SandboxSessionLike> = (
  session: TSession,
  need: ExpansionNeed
) => SandboxExpansionPolicyResult;

export interface OneShotSandboxRuntime<TSession extends SandboxSessionLike = SandboxSessionLike> {
  readonly approved: boolean;
  readonly need: ExpansionNeed;
  readonly originalSession: TSession;
  sessionForCall(): TSession;
  isConsumed(): boolean;
}

export function detectNeed(input: DetectNeedInput): ExpansionNeed | undefined {
  const hint = input.hint ? SandboxExpansionHintSchema.parse(input.hint) : undefined;
  if (hint) {
    return normalizeNeed({
      paths: hint.paths ?? [],
      network: hint.network ?? false,
      reason: hint.reason,
      source: "proactive-classifier"
    });
  }

  const denial = input.denial ? SandboxDenialSignalSchema.parse(input.denial) : undefined;
  if (!denial) {
    return undefined;
  }

  const reason = [denial.error, denial.stderr, denial.stdout].find((value) => value && value.trim().length > 0)?.trim();
  const paths = denial.requestedPaths ?? [];
  const network = denial.requestedNetwork ?? false;
  if (paths.length > 0 || network) {
    return normalizeNeed({
      paths,
      network,
      reason: reason ?? "Sandbox denied required capability.",
      source: "denial-signal"
    });
  }

  if (reason && PATH_DENIAL_PATTERN.test(reason)) {
    return undefined;
  }

  if (reason && NETWORK_DENIAL_PATTERN.test(reason)) {
    return normalizeNeed({
      paths: [],
      network: true,
      reason,
      source: "denial-signal"
    });
  }

  return undefined;
}

export function applyOneShotExpansion<TSession extends SandboxSessionLike>(
  session: TSession,
  need: ExpansionNeed,
  decision: ExpansionDecision,
  options: { readonly policy?: SandboxExpansionPolicy<TSession> } = {}
): OneShotSandboxRuntime<TSession> {
  const normalizedNeed = normalizeNeed(need);
  const parsedDecision = ExpansionDecisionSchema.parse(decision);
  const allowed =
    parsedDecision === "approve" &&
    (options.policy ? options.policy(session, normalizedNeed).allowed : true);

  let consumed = false;
  const expandedSession = allowed ? cloneSessionWithExpansion(session, normalizedNeed) : session;

  return {
    approved: allowed,
    need: normalizedNeed,
    originalSession: session,
    sessionForCall(): TSession {
      if (!allowed || consumed) {
        consumed = true;
        return session;
      }
      consumed = true;
      return expandedSession;
    },
    isConsumed(): boolean {
      return consumed;
    }
  };
}

function normalizeNeed(need: ExpansionNeed): ExpansionNeed {
  const parsed = ExpansionNeedSchema.parse(need);
  const uniquePaths = [...new Set(parsed.paths.map((value) => resolve(value)))];
  return {
    ...parsed,
    paths: uniquePaths
  };
}

function cloneSessionWithExpansion<TSession extends SandboxSessionLike>(session: TSession, need: ExpansionNeed): TSession {
  const allowPaths = [...new Set([...session.sandbox.allowPaths.map((value) => resolve(value)), ...need.paths])];
  return {
    ...session,
    sandbox: {
      ...session.sandbox,
      mode: session.sandbox.mode,
      allowPaths,
      network: session.sandbox.network || need.network
    }
  };
}
