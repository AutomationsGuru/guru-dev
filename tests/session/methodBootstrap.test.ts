import { describe, expect, it } from "vitest";

import type { ChatTurnMessage } from '../../src/model/directChat.js';

import {
  METHOD_BOOTSTRAP_PREFIX,
  ensureBootstrapAfterCompact,
  findMethodBootstrap,
  isMethodBootstrap
} from '../../src/session/methodBootstrap.js';

function bootstrap(body: string): ChatTurnMessage {
  return { role: "system", content: `${METHOD_BOOTSTRAP_PREFIX}\n${body}` };
}

function sys(content: string): ChatTurnMessage {
  return { role: "system", content };
}

const BOOTSTRAP_BODY = "Stay a problem-solver: state the BUILD/ATTACH/LEARN move before declaring a blocker.";

describe("methodBootstrap — isMethodBootstrap", () => {
  it("recognizes a system message that starts with the bootstrap prefix", () => {
    expect(isMethodBootstrap(bootstrap(BOOTSTRAP_BODY))).toBe(true);
  });

  it("rejects non-system messages even if content matches", () => {
    expect(isMethodBootstrap({ role: "user", content: `${METHOD_BOOTSTRAP_PREFIX}\nx` })).toBe(false);
  });

  it("rejects unrelated system messages (steering, compaction summary, etc.)", () => {
    expect(isMethodBootstrap(sys("[steering] keep it short"))).toBe(false);
    expect(isMethodBootstrap(sys("[compaction summary] (1 compaction)\nfolded…"))).toBe(false);
  });
});

describe("methodBootstrap — findMethodBootstrap", () => {
  it("returns the first bootstrap message in the history", () => {
    const marker = bootstrap(BOOTSTRAP_BODY);
    const history: ChatTurnMessage[] = [sys("you are guru"), marker, { role: "user", content: "hi" }];
    expect(findMethodBootstrap(history)).toStrictEqual(marker);
  });

  it("returns undefined when no bootstrap marker is present", () => {
    expect(findMethodBootstrap([sys("you are guru"), { role: "user", content: "hi" }])).toBeUndefined();
  });
});

describe("methodBootstrap — ensureBootstrapAfterCompact", () => {
  it("RED: compact drops free text but the bootstrap marker is restored at the head", () => {
    const before: ChatTurnMessage[] = [
      sys("you are guru"),
      bootstrap(BOOTSTRAP_BODY),
      { role: "user", content: "long preamble that should be folded" },
      { role: "assistant", content: "long reply that should be folded" }
    ];
    // Compact folded everything into a summary and dropped the bootstrap marker.
    const after: ChatTurnMessage[] = [
      sys("[compaction summary] (1 compaction; ~400 tok folded)\npreamble + reply folded"),
      { role: "user", content: "continue" }
    ];

    const restored = ensureBootstrapAfterCompact(before, after);

    expect(isMethodBootstrap(restored[0]!)).toBe(true);
    // The marker carries the original methodology body verbatim.
    expect(restored[0]).toStrictEqual(bootstrap(BOOTSTRAP_BODY));
    // The compact summary and the kept turn survive below the marker.
    expect(restored.slice(1)).toStrictEqual(after);
  });

  it("is a no-op when the bootstrap marker already survived compact", () => {
    const before: ChatTurnMessage[] = [bootstrap(BOOTSTRAP_BODY), { role: "user", content: "x" }];
    const after: ChatTurnMessage[] = [
      bootstrap(BOOTSTRAP_BODY),
      sys("[compaction summary] (1 compaction)\nfolded")
    ];
    expect(ensureBootstrapAfterCompact(before, after)).toBe(after);
  });

  it("is a no-op when before never carried a bootstrap marker (never invent one)", () => {
    const before: ChatTurnMessage[] = [sys("you are guru"), { role: "user", content: "x" }];
    const after: ChatTurnMessage[] = [sys("[compaction summary] (1 compaction)\nfolded")];
    expect(ensureBootstrapAfterCompact(before, after)).toBe(after);
  });

  it("does not mutate the input arrays", () => {
    const before: ChatTurnMessage[] = [bootstrap(BOOTSTRAP_BODY), { role: "user", content: "x" }];
    const after: ChatTurnMessage[] = [sys("[compaction summary]\nfolded")];
    const beforeSnapshot = before.map((m) => ({ ...m }));
    const afterSnapshot = after.map((m) => ({ ...m }));

    ensureBootstrapAfterCompact(before, after);

    expect(before).toStrictEqual(beforeSnapshot);
    expect(after).toStrictEqual(afterSnapshot);
  });

  it("restores even when the head was a non-bootstrap system message", () => {
    const before: ChatTurnMessage[] = [sys("you are guru"), bootstrap(BOOTSTRAP_BODY)];
    const after: ChatTurnMessage[] = [sys("[compaction summary]\nfolded")];
    const restored = ensureBootstrapAfterCompact(before, after);
    // The re-injected marker leads; we do not re-add the pre-existing head.
    expect(restored[0]).toStrictEqual(bootstrap(BOOTSTRAP_BODY));
    expect(restored.slice(1)).toStrictEqual(after);
  });
});
