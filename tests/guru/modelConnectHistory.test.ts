import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  abortTurnMessage,
  emptyTurnFollowUpTip,
  emptyTurnMessage,
  preserveHistoryOnModelSwitch,
  turnFailureTip
} from "../../src/guru/turnMessages.js";
import type { ChatTurnMessage } from "../../src/model/directChat.js";

const repoSrc = join(dirname(fileURLToPath(import.meta.url)), "../../src");

describe("preserveHistoryOnModelSwitch", () => {
  it("keeps user/assistant turns and only refreshes the system head", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: "old system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "continue" }
    ];
    const next = preserveHistoryOnModelSwitch(history, "new system for model B");
    expect(next[0]).toEqual({ role: "system", content: "new system for model B" });
    expect(next.slice(1)).toEqual(history.slice(1));
    expect(next).toHaveLength(4);
  });

  it("seeds a system head when history is empty", () => {
    expect(preserveHistoryOnModelSwitch([], "SYS")).toEqual([{ role: "system", content: "SYS" }]);
  });

  it("prepends system when history has no system head", () => {
    const history: ChatTurnMessage[] = [{ role: "user", content: "orphan" }];
    expect(preserveHistoryOnModelSwitch(history, "SYS")).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "orphan" }
    ]);
  });
});

describe("empty / failure operator copy", () => {
  it("names empty responses instead of a mute placeholder", () => {
    expect(emptyTurnMessage(0)).toMatch(/empty response/iu);
    expect(emptyTurnMessage(0)).toMatch(/\/model/u);
    expect(emptyTurnMessage(3)).toMatch(/3 tool call/iu);
    expect(emptyTurnMessage(3)).toMatch(/no final text/iu);
    expect(emptyTurnFollowUpTip(3)).toMatch(/follow-up/iu);
    expect(emptyTurnFollowUpTip(0)).toBeUndefined();
  });

  it("gives actionable tips on failure; abort stays soft", () => {
    expect(turnFailureTip("HTTP 401 unauthorized")).toMatch(/\/login|\/keys/u);
    expect(turnFailureTip("request failed: network ECONNRESET")).toMatch(/timeout|network|esc/iu);
    expect(turnFailureTip("rate limited 429")).toMatch(/rate limited/iu);
    expect(abortTurnMessage()).toMatch(/turn stopped/iu);
  });
});

describe("live REPL vs tui/state quarantine", () => {
  it("guru.ts does not drive the pane-TUI reducer (attachComposer is the live path)", () => {
    const source = readFileSync(join(repoSrc, "guru.ts"), "utf8");
    expect(source).not.toMatch(/reduceTuiState|from ["'].*tui\/state/u);
    expect(source).toMatch(/attachComposer/u);
    expect(source).toMatch(/preserveHistoryOnModelSwitch/u);
  });

  it("tui/state.ts is marked as NOT the live REPL", () => {
    const source = readFileSync(join(repoSrc, "tui/state.ts"), "utf8");
    expect(source).toMatch(/NOT THE LIVE REPL/u);
    expect(source).toMatch(/QUARANTINED/u);
  });
});
