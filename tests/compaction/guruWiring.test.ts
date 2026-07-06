import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  effectiveKeepRecentTokens,
  estimateChatHistoryTokens,
  historyToCompactionEntries,
  rebuildHistoryAfterCompaction,
  sendableHistory,
  trackCompactionFileOp,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  SLASH_COMMANDS
} from "../../src/guru.js";
import { runCompaction, shouldCompact, SUMMARY_ENTRY_PREFIX } from "../../src/compaction/engine.js";
import { CompactionConfigSchema } from "../../src/compaction/schemas.js";
import { createConversationStore } from "../../src/guru/conversationStore.js";
import { clearRegisteredSecretValues, registerSecretValue } from "../../src/safety/secretSafety.js";
import type { ChatTurnMessage } from "../../src/model/directChat.js";

const NOW = new Date("2026-07-04T12:00:00.000Z");

afterEach(() => {
  clearRegisteredSecretValues();
});

describe("history adapter", () => {
  it("preserves the system head, stamps e<index> ids, and maps roles to kinds", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: "SYSTEM-HEAD" },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" }
    ];
    const adapted = historyToCompactionEntries(history);
    expect(adapted.head.content).toBe("SYSTEM-HEAD");
    expect(adapted.previousSummary).toBeUndefined();
    expect(adapted.entries).toEqual([
      { id: "e1", kind: "user", content: "one" },
      { id: "e2", kind: "assistant", content: "two" }
    ]);
  });

  it("recognizes a previous summary entry, excludes it, and extracts its text (iterative)", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: "SYSTEM-HEAD" },
      { role: "system", content: `${SUMMARY_ENTRY_PREFIX} (1 compaction; ~500 tok folded)\nPRIOR-SUMMARY-TEXT` },
      { role: "user", content: "next question" }
    ];
    const adapted = historyToCompactionEntries(history);
    expect(adapted.previousSummary).toBe("PRIOR-SUMMARY-TEXT");
    expect(adapted.entries).toHaveLength(1);
    expect(adapted.entries[0]?.content).toBe("next question");
  });

  it("keeps mid-history system hints (look-ahead) as compactable system entries", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: "SYSTEM-HEAD" },
      { role: "user", content: "q" },
      { role: "system", content: "[look-ahead] a scout reasoned past this fork" },
      { role: "assistant", content: "a" }
    ];
    const adapted = historyToCompactionEntries(history);
    expect(adapted.entries.map((entry) => entry.kind)).toEqual(["user", "system", "assistant"]);
  });
});

describe("rebuild + sendable window", () => {
  it("rebuilds as [head, summary system message, ...kept]", () => {
    const rebuilt = rebuildHistoryAfterCompaction(
      { role: "system", content: "HEAD" },
      { id: "summary-1", kind: "system", content: `${SUMMARY_ENTRY_PREFIX}\nTHE SUMMARY` },
      [
        { id: "e9", kind: "user", content: "kept question" },
        { id: "e10", kind: "assistant", content: "kept answer" }
      ]
    );
    expect(rebuilt).toEqual([
      { role: "system", content: "HEAD" },
      { role: "system", content: `${SUMMARY_ENTRY_PREFIX}\nTHE SUMMARY` },
      { role: "user", content: "kept question" },
      { role: "assistant", content: "kept answer" }
    ]);
  });

  it("sendableHistory: full history when compaction is on; the exact legacy slice(-13) when off", () => {
    const history: ChatTurnMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`
    }));
    expect(sendableHistory(history, true)).toEqual(history);
    expect(sendableHistory(history, false)).toEqual(history.slice(-13));
  });
});

describe("file-op tracking at the executeTool seam", () => {
  it("routes read → readFiles and write/edit → modifiedFiles; ignores everything else", () => {
    const files = { readFiles: new Set<string>(), modifiedFiles: new Set<string>() };
    trackCompactionFileOp(files, "read", { path: "src/a.ts" });
    trackCompactionFileOp(files, "write", { path: "src/b.ts" });
    trackCompactionFileOp(files, "edit", { path: "src/c.ts" });
    trackCompactionFileOp(files, "bash", { command: "ls" });
    trackCompactionFileOp(files, "read", { path: "" });
    trackCompactionFileOp(files, "read", null);
    trackCompactionFileOp(files, "read", "not-an-object");
    expect([...files.readFiles]).toEqual(["src/a.ts"]);
    expect([...files.modifiedFiles].sort()).toEqual(["src/b.ts", "src/c.ts"]);
  });
});

describe("/compact surfaces", () => {
  it("is a registered slash command (menu + /help pick it up automatically)", () => {
    const compact = SLASH_COMMANDS.find((command) => command.name === "/compact");
    expect(compact).toBeDefined();
    expect(compact?.usage).toContain("[instructions]");
  });

  it("ANTI-THRASH clamp: keepRecentTokens ≥ threshold is reconciled so compaction can land below the trigger", () => {
    const config = CompactionConfigSchema.parse({ keepRecentTokens: 200_000, reserveTokens: 16_384 });
    const window = 200_000;
    const threshold = window - config.reserveTokens;
    const effective = effectiveKeepRecentTokens(config, window);
    expect(effective).toBeLessThan(threshold);
    expect(effective).toBe(Math.floor(threshold / 2));
    // Sane configs pass through untouched.
    const sane = CompactionConfigSchema.parse({});
    expect(effectiveKeepRecentTokens(sane, 128_000)).toBe(sane.keepRecentTokens);
    // Degenerate window (reserve ≥ window) leaves the config value alone (trigger never fires there).
    expect(effectiveKeepRecentTokens(sane, 10_000)).toBe(sane.keepRecentTokens);
  });

  it("lanes with NO declared context window still compact via the the default fallback bound", () => {
    expect(FALLBACK_CONTEXT_WINDOW_TOKENS).toBe(128_000);
    const config = CompactionConfigSchema.parse({});
    // An ollama-local style session grown past fallback − reserve must trigger.
    expect(
      shouldCompact({
        config,
        contextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
        lastInputTokens: 0,
        estimatedTokens: FALLBACK_CONTEXT_WINDOW_TOKENS - config.reserveTokens + 1
      })
    ).toBe(true);
  });
});

describe("ACCEPTANCE: the auto-compaction flow end-to-end (deterministic, no network)", () => {
  it("an over-threshold transcript compacts, drops under the threshold, and the send window carries the summary", async () => {
    const config = CompactionConfigSchema.parse({ reserveTokens: 1_000, keepRecentTokens: 500 });
    const contextWindowTokens = 4_000;
    // Build a synthetic session big enough to cross window − reserve (3000 tok).
    const history: ChatTurnMessage[] = [{ role: "system", content: "SYSTEM-HEAD" }];
    for (let i = 0; i < 40; i += 1) {
      history.push({ role: "user", content: `question ${i} ${"q".repeat(300)}` });
      history.push({ role: "assistant", content: `answer ${i} ${"a".repeat(300)}` });
    }
    const estimated = estimateChatHistoryTokens(history);
    expect(estimated).toBeGreaterThan(contextWindowTokens - config.reserveTokens);

    // 1. The trigger fires (estimated signal; no provider usage needed).
    expect(shouldCompact({ config, contextWindowTokens, lastInputTokens: 0, estimatedTokens: estimated })).toBe(true);

    // 2. The engine folds the older region through the (injected) summary lane.
    const adapted = historyToCompactionEntries(history);
    const result = await runCompaction({
      entries: adapted.entries,
      config,
      summarize: () => Promise.resolve("The operator asked 40 numbered questions; all were answered."),
      now: () => NOW,
      reason: "threshold",
      sessionFiles: { readFiles: ["src/guru.ts"], modifiedFiles: [] }
    });
    if (result === null || "cancelled" in result) {
      throw new Error("expected a compaction run");
    }

    // 3. Rebuild: [head, summary, ...kept] — history now fits with room to reserve.
    const rebuilt = rebuildHistoryAfterCompaction(adapted.head, result.summaryEntry, result.keptEntries);
    expect(rebuilt[0]?.content).toBe("SYSTEM-HEAD");
    expect(rebuilt[1]?.content).toContain("40 numbered questions");
    const after = estimateChatHistoryTokens(rebuilt);
    expect(after).toBeLessThan(contextWindowTokens - config.reserveTokens);
    expect(shouldCompact({ config, contextWindowTokens, lastInputTokens: 0, estimatedTokens: after })).toBe(false);

    // 4. The send window carries the summary + kept turns (nothing silently dropped).
    const outgoing = sendableHistory(rebuilt, config.enabled);
    expect(outgoing).toEqual(rebuilt);
    expect(outgoing.some((message) => message.content.startsWith(SUMMARY_ENTRY_PREFIX))).toBe(true);

    // 5. The durable record captures the audit trail.
    expect(result.state.tokensBefore).toBeGreaterThan(0);
    expect(result.state.firstKeptEntryId).toMatch(/^e\d+$/u);
    expect(result.state.details.readFiles).toContain("src/guru.ts");
  });

  it("compaction.enabled=false restores the legacy behavior exactly (no trigger, slice window)", () => {
    const config = CompactionConfigSchema.parse({ enabled: false });
    const history: ChatTurnMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: "x".repeat(2_000)
    }));
    expect(
      shouldCompact({
        config,
        contextWindowTokens: 4_000,
        lastInputTokens: 999_999,
        estimatedTokens: estimateChatHistoryTokens(history)
      })
    ).toBe(false);
    expect(sendableHistory(history, config.enabled)).toEqual(history.slice(-13));
  });
});

describe("conversation store: the compaction record survives the disk roundtrip, scrubbed", () => {
  let directory: string;

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists + reloads record.compaction; a registered secret never reaches disk", () => {
    directory = mkdtempSync(join(tmpdir(), "guru-compaction-store-"));
    const secret = "sk-live-roundtrip-secret-98765";
    registerSecretValue(secret);
    const store = createConversationStore({ directory });
    store.save({
      id: "conv-1",
      title: "compaction roundtrip",
      routeId: "zai/glm-5-turbo",
      modelIdOverride: null,
      messages: [
        { role: "system", content: "head" },
        { role: "user", content: "hello" }
      ],
      turnCount: 3,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      compaction: {
        summary: `deployed with ${secret} and moved on`,
        firstKeptEntryId: "e41",
        tokensBefore: 12_345,
        compactedAt: NOW.toISOString(),
        count: 2,
        details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] }
      }
    });
    const loaded = store.load("conv-1");
    expect(loaded?.compaction?.count).toBe(2);
    expect(loaded?.compaction?.firstKeptEntryId).toBe("e41");
    expect(loaded?.compaction?.details.readFiles).toEqual(["src/a.ts"]);
    expect(loaded?.compaction?.summary).not.toContain(secret);
    const raw = readFileSync(join(directory, "conv-1.json"), "utf8");
    expect(raw).not.toContain(secret);
  });

  it("records without a compaction field still load (back-compat)", () => {
    directory = mkdtempSync(join(tmpdir(), "guru-compaction-store-"));
    const store = createConversationStore({ directory });
    store.save({
      id: "conv-legacy",
      title: "no compaction yet",
      routeId: null,
      modelIdOverride: null,
      messages: [{ role: "user", content: "hi" }],
      turnCount: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    });
    const loaded = store.load("conv-legacy");
    expect(loaded).toBeDefined();
    expect(loaded?.compaction).toBeUndefined();
  });
});
