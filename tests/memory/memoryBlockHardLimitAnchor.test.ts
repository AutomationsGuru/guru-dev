import { describe, expect, it } from "vitest";

import { ensureAnchor } from '../../src/memory/memoryBlockHardLimitAnchor.js';

describe("ensureAnchor", () => {
  it("inserts the required hard-limit text when the reserved block is missing", () => {
    const requiredText = "No leaked secrets.";

    expect(ensureAnchor(["## Guru memory\n- Fact one"], requiredText)).toEqual([
      requiredText,
      "## Guru memory\n- Fact one"
    ]);
  });

  it("leaves blocks unchanged when the required hard-limit text is already present", () => {
    const requiredText = "No leaked secrets.";
    const blocks = [
      `## Hard limits\n- ${requiredText}\n- No unapproved spend.`,
      "## Guru memory\n- Fact one"
    ];

    expect(ensureAnchor(blocks, requiredText)).toBe(blocks);
  });
});
