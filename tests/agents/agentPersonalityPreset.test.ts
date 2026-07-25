import { describe, expect, it } from "vitest";

import {
  applyPreset,
  DEFAULT_PERSONALITY_PRESET,
  HARD_LIMIT_BLOCK_LABEL,
  type AgentPersonalityBlock
} from '../../src/agents/agentPersonalityPreset.js';

describe("agent personality presets", () => {
  it("seeds a tutorial personality block", () => {
    const blocks: AgentPersonalityBlock[] = [];

    const result = applyPreset("tutorial", blocks);

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "personality", text: expect.stringContaining("tutorial") })
      ])
    );
    expect(blocks).toEqual([]);
  });

  it("rejects unknown preset ids", () => {
    expect(() => applyPreset("unknown", [])).toThrow(/unknown personality preset/i);
  });

  it("preserves the hard-limit block while applying a preset", () => {
    const hardLimit: AgentPersonalityBlock = {
      label: HARD_LIMIT_BLOCK_LABEL,
      text: "Five hard limits bind in every mode.",
      protected: true
    };

    const result = applyPreset("terse", [hardLimit]);

    expect(result.find((block) => block.label === HARD_LIMIT_BLOCK_LABEL)).toEqual(hardLimit);
    expect(result).toContainEqual(expect.objectContaining({ label: "personality" }));
  });

  it("keeps the default preset available as the stable baseline", () => {
    expect(DEFAULT_PERSONALITY_PRESET).toBe("default");
    expect(applyPreset(DEFAULT_PERSONALITY_PRESET, [])).toContainEqual(expect.objectContaining({ label: "personality" }));
  });
});
