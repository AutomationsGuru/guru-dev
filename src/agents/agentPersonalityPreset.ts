/**
 * Small, named personality presets for agent identity context.
 *
 * Presets only add system-flavor memory blocks. They never alter tools,
 * permissions, budgets, mandates, or the constitution's hard-limit block.
 */

export const DEFAULT_PERSONALITY_PRESET = "default" as const;
export const HARD_LIMIT_BLOCK_LABEL = "hard-limits" as const;

export type AgentPersonalityPreset = "default" | "tutorial" | "terse";

export interface AgentPersonalityBlock {
  readonly label: string;
  readonly text: string;
  readonly protected?: boolean;
}

const PRESET_TEXT: Readonly<Record<AgentPersonalityPreset, string>> = {
  default: "Be clear, practical, and outcome-focused. Explain decisions when useful.",
  tutorial: "Use a tutorial style: explain the reasoning, teach the relevant concepts, and make each next step clear.",
  terse: "Be concise and direct. Lead with the answer and omit unnecessary narration."
};

/**
 * Add or replace the named personality block for a built-in preset.
 * The input array is never mutated, and protected hard-limit blocks are copied
 * unchanged so a personality choice cannot weaken the constitution.
 */
export function applyPreset(id: string, blocks: readonly AgentPersonalityBlock[]): AgentPersonalityBlock[] {
  if (!isAgentPersonalityPreset(id)) {
    throw new Error(`Unknown personality preset: "${id}"`);
  }

  const next = blocks.map((block) => ({ ...block }));
  const personality: AgentPersonalityBlock = {
    label: "personality",
    text: PRESET_TEXT[id]
  };
  const index = next.findIndex((block) => block.label === personality.label);
  if (index === -1) {
    next.push(personality);
  } else {
    next[index] = personality;
  }
  return next;
}

function isAgentPersonalityPreset(id: string): id is AgentPersonalityPreset {
  return id === "default" || id === "tutorial" || id === "terse";
}
