import { z } from "zod";

import { HARD_EDGE_VERBS, type MandateGrant, type MandateState, type MandateVerb } from "../mandates/schema.js";
import { MANDATE_READ_ONLY_TOOLS, verbsForCall } from "../mandates/evaluate.js";

/**
 * Named swarm worker roles (IDEA-D4, 2026-07-18). A role is a typed, invocable
 * worker profile: a fixed tool allowlist, budget ceilings, and a maximum mode.
 * Roles NEVER widen a worker past the parent: {@link deriveChildMandate} clamps
 * every child mandate to mandate ∩ parent, hard edges are stripped from child
 * grants so the evaluate layer can never allow one silently, and YOLO does not
 * cascade (see {@link resolveChildYolo}). This module is pure — spawn plumbing
 * (schema fields, manager validation) belongs to the swarm schema/manager,
 * which consumes these primitives.
 */

/** Chat/TUI-invocable named worker types. */
export const SwarmRoleNameSchema = z.enum(["explore", "plan", "implementer", "review", "verifier", "general"]);
export type SwarmRoleName = z.infer<typeof SwarmRoleNameSchema>;

/** How a role constrains the worker's execution mode. */
export type SwarmRoleMode = "read-only" | "inherit";

/**
 * Depth and iteration/token budget ceilings are REQUIRED on every role
 * (no silent inherit, no unbounded worker): a role that does not declare its
 * ceilings cannot spawn. Execution clamps any parent-provided budget to these
 * ceilings (worker budget = min(requested, role ceiling)).
 */
export const SwarmRoleBudgetsSchema = z
  .object({
    maxToolCalls: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    maxSpawnDepth: z.number().int().nonnegative()
  })
  .strict();
export type SwarmRoleBudgets = z.infer<typeof SwarmRoleBudgetsSchema>;

export const SwarmRoleSchema = z
  .object({
    name: SwarmRoleNameSchema,
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    /**
     * Explicit tool allowlist — the worker's registry is intersected with this
     * set at spawn. The swarm trio stays invocable so workers can fan out
     * within their own ceilings.
     */
    toolAllowlist: z.array(z.string().trim().min(1)).min(1),
    mode: z.enum(["read-only", "inherit"]),
    budgets: SwarmRoleBudgetsSchema
  })
  .strict();
export type SwarmRole = z.infer<typeof SwarmRoleSchema>;

/** Structured error when a spawn names a role the registry does not know. */
export class UnknownSwarmRoleError extends Error {
  readonly code = "unknown_swarm_role";
  constructor(readonly role: string) {
    super(`Unknown swarm role '${role}' — spawn refused. Valid roles: ${[...SWARM_ROLES.keys()].join(", ")}.`);
    this.name = "UnknownSwarmRoleError";
  }
}

/**
 * The default explore-role allowlist is derived BY REFERENCE from the mandate
 * layer's read-only floor ({@link MANDATE_READ_ONLY_TOOLS}) — the exact set of
 * tools that carry zero mandate verbs. It is never a copy, so the role cannot
 * drift from the mandate's own notion of read-only.
 */
function exploreAllowlist(): readonly string[] {
  return [...MANDATE_READ_ONLY_TOOLS].sort();
}

/**
 * The general worker's tool universe: every tool id the mandate layer can
 * reason about — the read-only floor plus every verb-bearing tool registered
 * there. Kept as a function so a mandate-table change flows through.
 */
function generalAllowlist(): readonly string[] {
  const ids = new Set<string>(MANDATE_READ_ONLY_TOOLS);
  for (const id of VERB_BEARING_TOOL_IDS) {
    ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Tool ids that carry mandate verbs (mirrored from the mandate layer's verb
 * table; structurally pinned by the roles tests so a verb-table change without
 * a roles update fails loudly).
 */
const VERB_BEARING_TOOL_IDS: readonly string[] = [
  "bash",
  "shell.command.run",
  "edit",
  "write",
  "fs.edit.apply",
  "memory_remember",
  "memory_forget",
  "memory_doctor",
  "operational.state.write",
  "operational.decision.upsert",
  "operational.backlog.create",
  "operational.implementation.create",
  "operational.blocker.record",
  "git.pr.run",
  "github.pr.comment",
  "github.pr.review",
  "review.gates.run",
  "honcho_remember",
  "honcho_log_turn",
  "use_tool",
  "web_fetch",
  "web_search",
  "provider_cli_run",
  "pyautogui_mouse",
  "pyautogui_keyboard"
];

/** The swarm trio: permission-neutral, invocable from every role. */
const SWARM_TRIO: readonly string[] = ["spawn_agent", "get_task_output", "kill_task"];

function roleToolSet(base: readonly string[]): string[] {
  return [...new Set([...base, ...SWARM_TRIO])].sort();
}

const BUDGETS = {
  scout: { maxToolCalls: 8, maxTokens: 8_192, timeoutMs: 120_000, maxSpawnDepth: 1 },
  worker: { maxToolCalls: 16, maxTokens: 32_768, timeoutMs: 300_000, maxSpawnDepth: 2 },
  heavy: { maxToolCalls: 24, maxTokens: 65_536, timeoutMs: 600_000, maxSpawnDepth: 2 }
} as const satisfies Readonly<Record<string, SwarmRoleBudgets>>;

const ROLE_DEFINITIONS: readonly SwarmRole[] = [
  {
    name: "explore",
    title: "Explore worker",
    description:
      "Read-only scout. Its tool universe is exactly the mandate layer's read-only floor plus the swarm trio — it physically cannot mutate, spend, or touch the network beyond read tools.",
    toolAllowlist: roleToolSet(exploreAllowlist()),
    mode: "read-only",
    budgets: BUDGETS.scout
  },
  {
    name: "plan",
    title: "Plan worker",
    description: "Read-only planning analyst. Same read-only universe as explore with a deeper budget for multi-step analysis.",
    toolAllowlist: roleToolSet(exploreAllowlist()),
    mode: "read-only",
    budgets: BUDGETS.worker
  },
  {
    name: "review",
    title: "Review worker",
    description: "Read-only reviewer. Inspects diffs and evidence; never mutates the tree it reviews.",
    toolAllowlist: roleToolSet(exploreAllowlist()),
    mode: "read-only",
    budgets: BUDGETS.worker
  },
  {
    name: "verifier",
    title: "Verifier worker",
    description: "Read-only verifier. Runs inspections and reports; mutation belongs to the implementer lane.",
    toolAllowlist: roleToolSet(exploreAllowlist()),
    mode: "read-only",
    budgets: BUDGETS.worker
  },
  {
    name: "implementer",
    title: "Implementer worker",
    description:
      "Mutating builder. Inherits the parent's live approval policy per call (mode 'all'), bounded by its own budgets and the clamped child mandate — never wider than the parent.",
    toolAllowlist: roleToolSet(generalAllowlist()),
    mode: "inherit",
    budgets: BUDGETS.worker
  },
  {
    name: "general",
    title: "General worker",
    description:
      "General-purpose worker. Inherits the parent's live approval policy per call, bounded by its own budgets and the clamped child mandate — never wider than the parent.",
    toolAllowlist: roleToolSet(generalAllowlist()),
    mode: "inherit",
    budgets: BUDGETS.heavy
  }
];

const SWARM_ROLES: ReadonlyMap<SwarmRoleName, SwarmRole> = new Map(ROLE_DEFINITIONS.map((role) => [role.name, role]));

/** Fail-closed role lookup: an unknown name throws, never defaults open. */
export function getSwarmRole(name: string): SwarmRole {
  const role = SWARM_ROLES.get(name as SwarmRoleName);
  if (!role) {
    throw new UnknownSwarmRoleError(name);
  }
  return role;
}

export function listSwarmRoles(): readonly SwarmRole[] {
  return [...SWARM_ROLES.values()];
}

/**
 * The worker's execution mode. A `read-only` role is ALWAYS read-only — the
 * parent cannot widen it. An `inherit` role follows the requested/parent mode.
 */
export function resolveRoleMode(role: SwarmRole, parentMode: "read-only" | "all"): "read-only" | "all" {
  return role.mode === "read-only" ? "read-only" : parentMode;
}

/**
 * True when the role's tool universe admits the call. Pure set membership —
 * the spawn layer intersects the worker registry with this set, so a tool
 * outside the allowlist is ABSENT for the worker (not merely gated).
 */
export function roleAllowsTool(role: SwarmRole, toolId: string): boolean {
  return role.toolAllowlist.includes(toolId);
}

/** Clamp a requested budget to the role's ceiling (worker budget ≤ role ceiling). */
export function clampBudget(role: SwarmRole, requested: number, ceiling: keyof SwarmRoleBudgets): number {
  return Math.min(requested, role.budgets[ceiling]);
}

/**
 * Child mandate = mandate ∩ parent, structurally:
 *
 * 1. Every parent DENY carries down unchanged (deny-wins survives inheritance).
 * 2. Grants are intersected with the role's tool universe: any verb the role
 *    cannot exercise through its allowlisted tools is dropped from the child
 *    grant, so the child can never hold a grant for a capability it lacks.
 * 3. HARD-EDGE verbs are stripped from every child grant. Hard edges are never
 *    covered by a standing grant anyway (evaluate escalates them in every
 *    mode), so a child carrying one would be inert at best and a lie at worst.
 *    Denies of hard-edge verbs carry down untouched.
 * 4. Grants emptied by the intersection are dropped; the result is always a
 *    valid MandateState.
 *
 * The child can therefore never exceed the parent: it holds at most the
 * parent's denies and a subset of the parent's grants.
 */
export function deriveChildMandate(role: SwarmRole, parent: MandateState): MandateState {
  const grants: MandateGrant[] = [];
  for (const grant of parent.grants) {
    const verbs = grant.verbs.filter((verb) => !HARD_EDGE_VERBS.has(verb) && grantVerbIsExercisable(role, verb));
    if (verbs.length === 0) {
      continue;
    }
    grants.push({ ...grant, verbs });
  }
  return { grants, denies: [...parent.denies] };
}

/**
 * A verb is exercisable by the role only when at least one of its allowlisted
 * tools can carry that verb for SOME input (per the mandate layer's own
 * verb-derivation table). Probing a representative input per tool keeps this
 * grounded in `verbsForCall` rather than a parallel table.
 */
function grantVerbIsExercisable(role: SwarmRole, verb: MandateVerb): boolean {
  if (verb === "read") {
    return true; // read is the always-allowed floor; no grant meaningfully carries it
  }
  for (const toolId of role.toolAllowlist) {
    const probe = probeInputFor(toolId);
    if (verbsForCall(toolId, probe).includes(verb)) {
      return true;
    }
  }
  return false;
}

/** Minimal representative inputs for verb probing — never executed. */
function probeInputFor(toolId: string): unknown {
  switch (toolId) {
    case "bash":
    case "shell.command.run":
      return { command: "true" };
    case "write":
    case "edit":
    case "fs.edit.apply":
      return { path: "probe.txt" };
    case "web_fetch":
      return { url: "http://localhost/" };
    default:
      return {};
  }
}

/**
 * YOLO does NOT cascade. A YOLO parent spawns a non-YOLO child by default; the
 * child runs under ordinary mandate evaluation (denies and hard edges still
 * bind, as they do for the parent). The only exception is an explicit
 * per-spawn child flag from the operator — and even then the child's hard
 * edges still escalate, because evaluate resolves hard edges before YOLO.
 * There is no path here that lifts a deny or a hard edge.
 */
export function resolveChildYolo(parentYolo: boolean, explicitChildYoloFlag: boolean): boolean {
  return parentYolo && explicitChildYoloFlag;
}

/**
 * Product copy (R-AS-FACE): the operator talks to the Guru face only. Spawned
 * workers are invisible machinery behind the face — the face reports their
 * results; workers never address the operator directly.
 */
export const SWARM_FACE_COPY: readonly string[] = [
  "You are talking to Guru. Guru may send out bounded workers; their results come back through Guru.",
  "Workers never ask you questions directly — Guru decides what needs your answer."
];
