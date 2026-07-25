import { createHash } from "node:crypto";

import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * Channel Inject Gate (IDEA-F290-CHANNEL-INJECT-01).
 *
 * The SMALLEST pure preflight for an externally-originated message that *may* be
 * injected into a running session. It is a decision function only: it never
 * delivers, never authorizes, never mutates state, never executes anything, and
 * holds no authority of its own. A future, separately-owned delivery surface calls
 * it and acts on the returned decision.
 *
 * The gate reuses the existing secret scrubber ({@link scrubSecretValues}) so the
 * "canonical scrubbing" requirement means one thing repository-wide: a payload body
 * is run through the same structural scrubber used at every other output choke
 * point, and its hash is taken over the scrubbed, normalized form. The caller
 * supplies the hash it claims; the gate recomputes and compares. A mismatch (tamper,
 * uncanonicalized input, or a secret the issuer tried to ship raw) → deny.
 *
 * Decision is two-valued and fail-closed:
 *   - "deny"            — anything missing/invalid: unknown channel, missing
 *                         provenance metadata, project/session mismatch, expired,
 *                         replayed nonce, or payloadHash that does not match the
 *                         recomputed canonical hash.
 *   - "approval_needed" — fully valid; the inject is eligible in shape but still
 *                         requires explicit operator approval before any delivery.
 *                         There is no "allow"/"go" outcome: this gate authorizes
 *                         nothing. Callers must obtain approval out of band.
 *
 * All trust inputs are injected as a read-only context (allowlist, expected binding,
 * clock, an auth predicate, a replay predicate) so the function is pure and
 * deterministically testable.
 */

/** A channel id is a non-empty slug (e.g. "kanban", "mailbox"). */
export type ChannelId = string;

/** Authenticated provenance metadata the issuer MUST attach. Presence-bound only. */
export interface InjectProvenance {
  /** Stable id of the issuing system. */
  readonly issuer: string;
  /** ISO-8601 UTC the issuer created this inject. */
  readonly issuedAt: string;
}

/** The externally-originated payload. The body is scrubbed before hashing. */
export interface InjectPayload {
  readonly kind: string;
  readonly body: string;
}

/** A typed inject request, post-transport and pre-decision. */
export interface ChannelInjectRequest {
  readonly channel: ChannelId;
  /** Project the inject targets; must equal the session's bound project. */
  readonly projectId: string;
  /** Session the inject targets; must equal the live session id. */
  readonly sessionId: string;
  readonly payload: InjectPayload;
  readonly provenance: InjectProvenance;
  /** sha256 hex the issuer claims over the canonical (scrubbed) payload. */
  readonly payloadHash: string;
  /** ISO-8601 UTC after which the inject MUST be rejected. */
  readonly expiresAt: string;
  /** Single-use nonce; a reused nonce is replay. */
  readonly replayNonce: string;
}

/**
 * Read-only decision context. Every trust input is injected so the gate is a pure
 * function of (request, ctx). `isAuthenticated` decides whether provenance is
 * trusted (the gate does no signature/crypto of its own); `hasSeenNonce` is a pure
 * replay lookup the caller wires to its nonce store.
 */
export interface ChannelInjectContext {
  readonly allowedChannels: ReadonlySet<ChannelId>;
  readonly expectedProjectId: string;
  readonly expectedSessionId: string;
  /** Epoch ms; injected for deterministic freshness checks. */
  readonly now: number;
  /** True iff `provenance` is trusted/authenticated for this request. */
  readonly isAuthenticated: (provenance: InjectProvenance) => boolean;
  /** True iff `nonce` was already consumed for `channel`. */
  readonly hasSeenNonce: (channel: ChannelId, nonce: string) => boolean;
}

export type ChannelInjectDecision =
  | { readonly decision: "deny"; readonly reason: string }
  | {
      readonly decision: "approval_needed";
      /** The scrubbed payload body, safe to surface to an approver. */
      readonly sanitizedPayload: string;
      /** The gate's recomputed canonical hash. */
      readonly payloadHash: string;
    };

/**
 * Canonical scrubbing of a payload body: collapse whitespace, then run the shared
 * secret scrubber so any token-shaped or registered secret value is redacted to its
 * placeholder before hashing. Two equivalent payloads hash identically; a payload
 * containing a raw secret is normalized to its redacted form. Pure and non-mutating.
 */
export function canonicalizePayloadBody(body: string): string {
  return scrubSecretValues(body.replace(/\s+/gu, " ").trim());
}

/** sha256 hex (lowercase) over the canonical payload body, UTF-8. */
export function canonicalPayloadHash(body: string): string {
  return createHash("sha256").update(canonicalizePayloadBody(body), "utf8").digest("hex");
}

/**
 * Preflight an inject. Returns a deny decision (with a named reason) for any missing
 * or invalid requirement, else an approval_needed decision carrying the scrubbed
 * payload and recomputed hash. Never delivers, never authorizes, never mutates.
 */
export function evaluateChannelInject(
  request: ChannelInjectRequest,
  ctx: ChannelInjectContext
): ChannelInjectDecision {
  // Channel allowlist — no open surface without explicit config.
  if (!ctx.allowedChannels.has(request.channel)) {
    return { decision: "deny", reason: `channel "${request.channel}" is not allowlisted` };
  }

  // Authenticated provenance metadata — issuer + issuedAt must be present and trusted.
  if (!request.provenance || !request.provenance.issuer || !request.provenance.issuedAt) {
    return { decision: "deny", reason: "missing provenance metadata (issuer/issuedAt)" };
  }
  if (!ctx.isAuthenticated(request.provenance)) {
    return { decision: "deny", reason: "provenance is not authenticated" };
  }

  // Exact project/session binding.
  if (request.projectId !== ctx.expectedProjectId) {
    return { decision: "deny", reason: "project binding mismatch" };
  }
  if (request.sessionId !== ctx.expectedSessionId) {
    return { decision: "deny", reason: "session binding mismatch" };
  }

  // Freshness — reject expired injects relative to the injected clock.
  const expiresMs = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresMs)) {
    return { decision: "deny", reason: "expiresAt is not a valid ISO-8601 timestamp" };
  }
  if (expiresMs <= ctx.now) {
    return { decision: "deny", reason: "inject has expired" };
  }

  // Replay — a nonce may be used at most once per channel.
  if (!request.replayNonce || request.replayNonce.length === 0) {
    return { decision: "deny", reason: "missing replay nonce" };
  }
  if (ctx.hasSeenNonce(request.channel, request.replayNonce)) {
    return { decision: "deny", reason: "replay detected (nonce already seen)" };
  }

  // Integrity — the caller's claimed hash must equal the deterministic hash of the
  // canonically scrubbed payload. Mismatch = tamper / uncanonicalized / raw secret.
  if (!/^[0-9a-f]{64}$/iu.test(request.payloadHash)) {
    return { decision: "deny", reason: "payloadHash is not a 64-char lowercase sha256 hex" };
  }
  const recomputed = canonicalPayloadHash(request.payload.body);
  if (recomputed !== request.payloadHash) {
    return { decision: "deny", reason: "payloadHash does not match canonical scrubbed payload" };
  }

  return {
    decision: "approval_needed",
    sanitizedPayload: canonicalizePayloadBody(request.payload.body),
    payloadHash: recomputed
  };
}
