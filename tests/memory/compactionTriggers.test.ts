import { describe, expect, it } from "vitest";

import {
  groupsExceed,
  messagesExceed,
  shouldCompact,
  turnsExceed,
  type CompactionTriggers,
  type ConversationStats
} from '../../src/memory/compactionTriggers.js';

function stats(overrides: Partial<ConversationStats> = {}): ConversationStats {
  return { messages: 0, turns: 0, groups: 0, ...overrides };
}

function triggers(overrides: Partial<CompactionTriggers> = {}): CompactionTriggers {
  return { ...overrides };
}

describe("messagesExceed", () => {
  it("is false at or below the threshold", () => {
    expect(messagesExceed(10)(stats({ messages: 0 }))).toBe(false);
    expect(messagesExceed(10)(stats({ messages: 10 }))).toBe(false);
  });

  it("is true strictly above the threshold", () => {
    expect(messagesExceed(10)(stats({ messages: 11 }))).toBe(true);
  });
});

describe("turnsExceed", () => {
  it("is false at or below the threshold", () => {
    expect(turnsExceed(4)(stats({ turns: 4 }))).toBe(false);
  });

  it("is true strictly above the threshold", () => {
    expect(turnsExceed(4)(stats({ turns: 5 }))).toBe(true);
  });
});

describe("groupsExceed", () => {
  it("is false at or below the threshold", () => {
    expect(groupsExceed(7)(stats({ groups: 7 }))).toBe(false);
  });

  it("is true strictly above the threshold", () => {
    expect(groupsExceed(7)(stats({ groups: 8 }))).toBe(true);
  });
});

describe("shouldCompact — any configured trigger fires", () => {
  it("is false when every count is under every configured threshold", () => {
    const decision = shouldCompact(
      stats({ messages: 9, turns: 3, groups: 6 }),
      triggers({ maxMessages: 10, maxTurns: 4, maxGroups: 7 })
    );
    expect(decision).toBe(false);
  });

  it("is true when messages exceed", () => {
    const decision = shouldCompact(
      stats({ messages: 11, turns: 0, groups: 0 }),
      triggers({ maxMessages: 10, maxTurns: 4, maxGroups: 7 })
    );
    expect(decision).toBe(true);
  });

  it("is true when turns exceed", () => {
    const decision = shouldCompact(
      stats({ messages: 0, turns: 5, groups: 0 }),
      triggers({ maxMessages: 10, maxTurns: 4, maxGroups: 7 })
    );
    expect(decision).toBe(true);
  });

  it("is true when groups exceed", () => {
    const decision = shouldCompact(
      stats({ messages: 0, turns: 0, groups: 8 }),
      triggers({ maxMessages: 10, maxTurns: 4, maxGroups: 7 })
    );
    expect(decision).toBe(true);
  });

  it("is false when no triggers are configured", () => {
    expect(shouldCompact(stats({ messages: 999, turns: 999, groups: 999 }), triggers())).toBe(false);
  });

  it("is false when a count only equals its threshold (exceed is strict)", () => {
    const decision = shouldCompact(
      stats({ messages: 10, turns: 4, groups: 7 }),
      triggers({ maxMessages: 10, maxTurns: 4, maxGroups: 7 })
    );
    expect(decision).toBe(false);
  });

  it("ignores unconfigured dimensions", () => {
    const decision = shouldCompact(
      stats({ messages: 999_999, turns: 0, groups: 0 }),
      triggers({ maxTurns: 4 })
    );
    expect(decision).toBe(false);
  });
});
