/**
 * Swarm tool scoping (IDEA-F6-SWARM-SCOPE-01, R-GO-SUB-SCOPE).
 *
 * A worker inherits a SUBSET of the parent's tools. Two invariants are
 * enforced here, in code — never in prompt:
 *
 *   1. **Spawn-tool removal.** The default worker allowlist is the parent's
 *      tools minus `spawn_agent`. A worker may still spawn if the operator
 *      explicitly re-adds the spawn tool to the child's allowlist, but the
 *      default is containment: swarm fan-out is opt-in per level.
 *
 *   2. **Hard-limit bypass exclusion.** A fixed set of tool ids is stripped
 *      from EVERY worker allowlist, whether or not the parent lists them and
 *      whether or not the caller explicitly requests them. These tools either
 *      mutate shared host state outside the worker's bounded turn (ship
 *      paths, schedule futures, external provider CLIs) or manage the
 *      session/meta surface that belongs to the parent alone. A YOLO parent
 *      cannot use a worker to launder a hard-limit bypass.
 *
 * The allowlist derived here is an intersection: `requested ∩ parent ∩
 * allowed-for-worker`. The worker can never widen past what the parent
 * already had; it can only narrow.
 *
 * This module is a pure, dependency-free helper. Composition (wiring the
 * derived allowlist into the swarm manager's spawn path and into the tool
 * registry view the worker sees) is owned by a follow-up packet — this
 * packet lands the structural primitive and its tests.
 */

/** The swarm's model-facing spawn tool id (see src/swarm/tools.ts). */
export const SPAWN_AGENT_TOOL_ID = "spawn_agent";

/**
 * Tools a worker never receives, even when the parent has them and even when
 * the caller explicitly lists them in `requestedAllowlist`. Membership is
 * structural (exact id match); the set is frozen so a caller cannot mutate
 * the constitution from inside a turn.
 *
 * Categories (mirrors the five hard limits in VISION §3):
 *  - Ship / external-mutation paths: `git.pr.run`, `github.pr.*` — §3.4
 *    out-of-scope crossing; a worker must not publish on the parent's behalf.
 *  - Self-build / meta surfaces: `manage_task`, `schedule`,
 *    `operational.implementation.create`, `operational.decision.upsert`,
 *    `operational.blocker.record`, `operational.backlog.create` — §3.5
 *    ungoverned self-improvement; the worker's bounded turn is not the
 *    governed self-mutation path.
 *  - External provider CLI bridges: `provider_cli_run` — ceiling drift; a
 *    worker runs on the parent's connected model, not on a side-channel
 *    provider CLI that would bypass mandate accounting.
 *  - Desktop automation: `pyautogui_*` — the desktop surface is the
 *    operator's own seat; a worker driving it is an operator-override risk.
 *  - Mandate / audit governors: `review.gates.run`, `maintenance.audit.run` —
 *    workers do not self-certify.
 *
 * Honcho memory tools are NOT in this list: a worker recalling or logging to
 * the shared memory surface is legitimate (subject to the mandate / approval
 * policy at execution time). Scrubbing of secret VALUES happens in the
 * registry choke point regardless of allowlist.
 */
export const HARD_LIMIT_BYPASS_TOOL_IDS: ReadonlySet<string> = new Set([
  // Ship paths (external mutation on the parent's behalf).
  "git.pr.run",
  "github.pr.comment",
  "github.pr.review",
  "github.pr.status",
  // Self-build / meta session surfaces.
  "manage_task",
  "schedule",
  "operational.implementation.create",
  "operational.decision.upsert",
  "operational.blocker.record",
  "operational.backlog.create",
  // External provider CLI bridge.
  "provider_cli_run",
  // Desktop automation (operator's seat).
  "pyautogui_status",
  "pyautogui_screen",
  "pyautogui_mouse",
  "pyautogui_keyboard",
  // Self-certification governors.
  "review.gates.run",
  "maintenance.audit.run"
]);

/**
 * Input for deriving a worker's tool allowlist.
 *
 * `parentToolIds` is the parent's CURRENT tool surface at spawn time (the
 * snapshot semantics match the mandate snapshot: a sibling change after
 * spawn does not retroactively reach an in-flight worker). `requestedAllowlist`
 * is the caller's explicit narrowing, when provided.
 */
export interface DeriveWorkerToolAllowlistInput {
  readonly parentToolIds: readonly string[];
  readonly requestedAllowlist?: readonly string[];
}

/**
 * Result of the derivation. `allowlist` is the effective worker surface —
 * sorted, deduplicated, and safe to pass to a registry view. `dropped` lists
 * the ids that were requested-or-present but stripped, with the reason, so
 * callers can surface an honest note instead of silently narrowing.
 */
export interface DerivedWorkerToolAllowlist {
  readonly allowlist: readonly string[];
  readonly dropped: readonly { readonly id: string; readonly reason: "spawn_tool" | "hard_limit_bypass" | "not_in_parent" }[];
}

/**
 * Derive the effective tool allowlist for a worker.
 *
 * Rules, applied in order:
 *  1. Start from `parentToolIds` (or `requestedAllowlist` if provided —
 *     intersected against the parent so the worker can never widen past the
 *     parent's surface).
 *  2. Strip `SPAWN_AGENT_TOOL_ID` unless it was explicitly requested AND the
 *     parent had it. Default containment; opt-in recursion.
 *  3. Strip every id in `HARD_LIMIT_BYPASS_TOOL_IDS`, unconditionally. This
 *     is the constitution enforced in code — no caller input can re-include
 *     them.
 *
 * Output is deterministic: sorted, deduplicated.
 */
export function deriveWorkerToolAllowlist(input: DeriveWorkerToolAllowlistInput): DerivedWorkerToolAllowlist {
  const parent = new Set(input.parentToolIds);
  const requested = input.requestedAllowlist ? new Set(input.requestedAllowlist) : undefined;
  const dropped: { id: string; reason: "spawn_tool" | "hard_limit_bypass" | "not_in_parent" }[] = [];
  const allowed: string[] = [];

  // The candidate pool: explicit request ∩ parent, or the parent itself.
  const pool = requested ?? parent;

  for (const id of pool) {
    if (!parent.has(id)) {
      // Caller asked for something the parent doesn't have — cannot widen.
      dropped.push({ id, reason: "not_in_parent" });
      continue;
    }
    if (HARD_LIMIT_BYPASS_TOOL_IDS.has(id)) {
      // Hard-limit bypass — never flows to a worker, even when the parent
      // has it and the caller asked for it. This check precedes the spawn
      // check so a bypass id is always reported as a bypass strip.
      dropped.push({ id, reason: "hard_limit_bypass" });
      continue;
    }
    if (id === SPAWN_AGENT_TOOL_ID) {
      // Spawn tool: strip UNLESS the caller explicitly opted the worker into
      // recursion by requesting it. The depth ceiling still applies on the
      // manager side; this is the tool-surface containment half.
      if (!requested) {
        dropped.push({ id, reason: "spawn_tool" });
        continue;
      }
    }
    allowed.push(id);
  }

  // Deterministic surface: sorted, deduped.
  allowed.sort();
  const deduped: string[] = [];
  let last: string | undefined;
  for (const id of allowed) {
    if (id !== last) {
      deduped.push(id);
      last = id;
    }
  }

  // Deterministic dropped order (sorted by id) so callers can render stable output.
  dropped.sort((a, b) => a.id.localeCompare(b.id));

  return { allowlist: deduped, dropped };
}

/**
 * Narrow an existing worker allowlist further (a worker spawning its own
 * sub-worker). Equivalent to `deriveWorkerToolAllowlist` with the current
 * worker's allowlist as the "parent" — the hard-limit bypass strip and the
 * spawn-tool default-containment both apply at every level of the tree, not
 * just the top.
 */
export function narrowWorkerToolAllowlist(
  currentWorkerToolIds: readonly string[],
  requestedAllowlist?: readonly string[]
): DerivedWorkerToolAllowlist {
  return deriveWorkerToolAllowlist({ parentToolIds: currentWorkerToolIds, ...(requestedAllowlist ? { requestedAllowlist } : {}) });
}
