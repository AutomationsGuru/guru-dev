import { SUMMARY_ENTRY_PREFIX } from "../../src/compaction/engine.js";
import {
  effectiveKeepRecentTokens,
  estimateChatHistoryTokens,
  historyToCompactionEntries,
  rebuildHistoryAfterCompaction
} from "../../src/compaction/sessionHistory.js";
import type { ChatTurnMessage } from "../../src/model/directChat.js";

describe("shared compaction session history", () => {
  it("preserves a leading system message as the noncompactable head", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" }
    ];

    expect(historyToCompactionEntries(history)).toEqual({
      head: { role: "system", content: "SYSTEM" },
      entries: [
        { id: "e1", kind: "user", content: "question" },
        { id: "e2", kind: "assistant", content: "answer" }
      ],
      previousSummary: undefined
    });
  });

  it("keeps the first user message in user-first compactable history", () => {
    const history: ChatTurnMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" }
    ];

    const adapted = historyToCompactionEntries(history);

    expect(adapted.head).toBeUndefined();
    expect(adapted.entries).toEqual([
      { id: "e0", kind: "user", content: "first question" },
      { id: "e1", kind: "assistant", content: "first answer" }
    ]);
  });

  it("recognizes and removes the previous iterative summary", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: "SYSTEM" },
      { role: "system", content: `${SUMMARY_ENTRY_PREFIX} (2 compactions; ~200 tok folded)\nPRIOR SUMMARY` },
      { role: "user", content: "continue" }
    ];

    const adapted = historyToCompactionEntries(history);

    expect(adapted.previousSummary).toBe("PRIOR SUMMARY");
    expect(adapted.entries).toEqual([{ id: "e2", kind: "user", content: "continue" }]);
  });

  it("recognizes a summary-first history without mistaking it for a protected head", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: `${SUMMARY_ENTRY_PREFIX} (1 compaction; ~100 tok folded)\nFIRST SUMMARY` },
      { role: "user", content: "second fold input" }
    ];

    const adapted = historyToCompactionEntries(history);

    expect(adapted.head).toBeUndefined();
    expect(adapted.previousSummary).toBe("FIRST SUMMARY");
    expect(adapted.entries).toEqual([{ id: "e1", kind: "user", content: "second fold input" }]);
  });

  it("rebuilds system-headed history with the compacted summary and kept turns", () => {
    const rebuilt = rebuildHistoryAfterCompaction(
      { role: "system", content: "SYSTEM" },
      { id: "summary-1", kind: "system", content: `${SUMMARY_ENTRY_PREFIX}\nSUMMARY` },
      [
        { id: "e8", kind: "user", content: "kept question" },
        { id: "e9", kind: "assistant", content: "kept answer" }
      ]
    );

    expect(rebuilt).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "system", content: `${SUMMARY_ENTRY_PREFIX}\nSUMMARY` },
      { role: "user", content: "kept question" },
      { role: "assistant", content: "kept answer" }
    ]);
  });

  it("rebuilds user-first history without inventing an empty protected head", () => {
    const rebuilt = rebuildHistoryAfterCompaction(
      undefined,
      { id: "summary-1", kind: "system", content: `${SUMMARY_ENTRY_PREFIX}\nSUMMARY` },
      [{ id: "e1", kind: "assistant", content: "kept answer" }]
    );

    expect(rebuilt).toEqual([
      { role: "system", content: `${SUMMARY_ENTRY_PREFIX}\nSUMMARY` },
      { role: "assistant", content: "kept answer" }
    ]);
  });

  it("estimates every chat message with transcript framing overhead", () => {
    expect(
      estimateChatHistoryTokens([
        { role: "user", content: "1234" },
        { role: "assistant", content: "12345" }
      ])
    ).toBe(11);
  });

  it("clamps an oversized keep budget while preserving sane and degenerate budgets", () => {
    const oversized = {
      enabled: true,
      reserveTokens: 1_000,
      keepRecentTokens: 5_000,
      summaryMaxTokens: 500
    } as const;
    const sane = { ...oversized, keepRecentTokens: 2_000 };

    expect(effectiveKeepRecentTokens(oversized, 5_000)).toBe(2_000);
    expect(effectiveKeepRecentTokens(sane, 5_000)).toBe(2_000);
    expect(effectiveKeepRecentTokens(sane, 500)).toBe(2_000);
  });
});
