import { z } from "zod";

/**
 * Agent-scoped skills (IDEA-F181-AGENT-SKILLS-01, R-LT-AGENT-SKILL).
 *
 * Binds additional skill ids to a specific agent id. When listing for an agent,
 * the result is the union of global + project + agent layers, with agent
 * bindings appended last (override/add semantics for that agent).
 *
 * This is a focused seam for agent-level skill specialization without editing
 * core garage or role manifests. Bindings are additive and detachable.
 */

const AgentIdSchema = z.string().trim().min(1);
const SkillIdSchema = z.string().trim().min(1);

const bindings = new Map<string, Set<string>>();

/** Attach a skill id to an agent. Idempotent. */
export function attach(agentId: string, skillId: string): void {
  const aid = AgentIdSchema.parse(agentId);
  const sid = SkillIdSchema.parse(skillId);
  if (!bindings.has(aid)) {
    bindings.set(aid, new Set());
  }
  bindings.get(aid)!.add(sid);
}

/** Detach a skill id from an agent. No-op if not present. */
export function detach(agentId: string, skillId: string): void {
  const aid = AgentIdSchema.parse(agentId);
  const sid = SkillIdSchema.parse(skillId);
  const set = bindings.get(aid);
  if (set) {
    set.delete(sid);
    if (set.size === 0) {
      bindings.delete(aid);
    }
  }
}

/**
 * List skills for the given agent.
 * Returns deduplicated list: global then project then agent-specific.
 * Agent bindings act as an override/add layer.
 */
export function listFor(
  agentId: string,
  global: readonly string[] = [],
  project: readonly string[] = []
): string[] {
  const aid = AgentIdSchema.parse(agentId);
  const agentSet = bindings.get(aid) ?? new Set<string>();
  const merged = new Set<string>([...global, ...project, ...agentSet]);
  return Array.from(merged);
}

/** Test helper: clear all bindings (for test isolation). */
export function __resetForTests(): void {
  bindings.clear();
}
