import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionLogStore, SESSION_LOG_SCHEMA_VERSION } from "../../src/guru/sessionLog.js";
import { clearRegisteredSecretValues, registerSecretValue } from "../../src/safety/secretSafety.js";

let counter = 0;
const dirs: string[] = [];
function freshStore() {
  const directory = join(tmpdir(), `guru-log-${process.pid}-${counter}`);
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  let idN = 0;
  let ms = 0;
  counter += 1;
  return createSessionLogStore({
    directory,
    newId: () => `x${counter}_${idN++}`,
    now: () => new Date(Date.UTC(2026, 6, 5, 0, 0, 0, ms++))
  });
}

afterEach(() => {
  clearRegisteredSecretValues();
});

describe("sessionLog — append-only JSONL DAG", () => {
  it("appends a parentId chain: each entry follows the previous, root parentId is null", () => {
    const store = freshStore();
    const meta = store.appendMeta("root", { title: "T", routeId: "r1", modelIdOverride: null });
    const a = store.appendMessage("root", { role: "user", content: "hi", mode: "normal" });
    const b = store.appendMessage("root", { role: "assistant", content: "hello", mode: "normal" });
    expect(meta.parentId).toBeNull();
    expect(a.parentId).toBe(meta.id);
    expect(b.parentId).toBe(a.id);
    expect(store.head("root")).toBe(b.id);
    const entries = store.readEntries("root");
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.schemaVersion === SESSION_LOG_SCHEMA_VERSION)).toBe(true);
  });

  it("ACCEPTANCE: reconstruct replays the FULL stream and restores route/title", () => {
    const store = freshStore();
    store.appendMeta("s", { title: "Auth work", routeId: "openai:gpt", modelIdOverride: "o" });
    store.appendMessage("s", { role: "system", content: "sys", mode: "normal" });
    store.appendMessage("s", { role: "user", content: "explain auth", mode: "normal" });
    store.appendMessage("s", { role: "assistant", content: "the flow is…", mode: "normal" });
    const session = store.load("s");
    expect(session?.title).toBe("Auth work");
    expect(session?.routeId).toBe("openai:gpt");
    expect(session?.modelIdOverride).toBe("o");
    expect(session?.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(session?.messages[2]?.content).toBe("the flow is…");
  });

  it("audit markers: mode + approver ride the message entry", () => {
    const store = freshStore();
    store.appendMessage("s", { role: "user", content: "rm", mode: "yolo", approver: "matt" });
    const [entry] = store.readEntries("s");
    expect(entry).toMatchObject({ kind: "message", mode: "yolo", approver: "matt" });
  });

  it("crash tolerance: a torn trailing line is skipped, the valid prefix still replays", () => {
    const store = freshStore();
    store.appendMeta("s", { title: "T", routeId: null, modelIdOverride: null });
    store.appendMessage("s", { role: "user", content: "one", mode: "normal" });
    // Simulate a process killed mid-append: a partial JSON line with no newline.
    appendFileSync(join(store.directory, "s.jsonl"), '{"kind":"message","content":"tor', "utf8");
    const entries = store.readEntries("s");
    expect(entries).toHaveLength(2);
    expect(store.load("s")?.messages).toHaveLength(1);
  });

  it("compaction entry restores CompactionState on replay without deleting message lines", () => {
    const store = freshStore();
    store.appendMessage("s", { role: "user", content: "a", mode: "normal" });
    store.appendMessage("s", { role: "assistant", content: "b", mode: "normal" });
    store.appendCompaction("s", {
      summary: "folded",
      firstKeptEntryId: "e1",
      tokensBefore: 100,
      compactedAt: "2026-07-05T00:00:00.000Z",
      count: 1,
      details: { readFiles: ["a.ts"], modifiedFiles: [] }
    });
    const session = store.load("s");
    expect(session?.compaction?.summary).toBe("folded");
    expect(session?.compaction?.count).toBe(1);
    // The message lines survive — the stream is lossless.
    expect(session?.messages).toHaveLength(2);
  });

  it("secret scrub at the disk boundary: a resolved value never lands in the log", () => {
    const store = freshStore();
    registerSecretValue("sk-supersecret-value-123456");
    store.appendMessage("s", { role: "assistant", content: "token is sk-supersecret-value-123456 ok", mode: "normal" });
    const raw = readFileSync(join(store.directory, "s.jsonl"), "utf8");
    expect(raw).not.toContain("sk-supersecret-value-123456");
    expect(store.load("s")?.messages[0]?.content).toContain("redacted");
  });
});

describe("sessionLog — fork / clone / the cross-session DAG", () => {
  it("ACCEPTANCE: /fork seeds a new session from a prior user message with lineage back", () => {
    const store = freshStore();
    store.appendMessage("root", { role: "user", content: "first", mode: "normal" });
    store.appendMessage("root", { role: "assistant", content: "reply-1", mode: "normal" });
    const second = store.appendMessage("root", { role: "user", content: "second", mode: "normal" });
    store.appendMessage("root", { role: "assistant", content: "reply-2", mode: "normal" });

    const forked = store.fork("root", second.id);
    expect(forked).toBeDefined();
    // Seeded through the SECOND user message (inclusive): first, reply-1, second.
    expect(forked?.session.messages.map((message) => message.content)).toEqual(["first", "reply-1", "second"]);
    expect(forked?.session.lineage).toEqual({ parentSessionId: "root", parentEntryId: second.id });
    // The parent is untouched — append-only, both branches alive.
    expect(store.load("root")?.messages).toHaveLength(4);
  });

  it("ACCEPTANCE: /clone duplicates the entire active branch, lineage at the head", () => {
    const store = freshStore();
    store.appendMessage("root", { role: "user", content: "u1", mode: "normal" });
    const head = store.appendMessage("root", { role: "assistant", content: "a1", mode: "normal" });
    const cloned = store.clone("root");
    expect(cloned?.session.messages.map((message) => message.content)).toEqual(["u1", "a1"]);
    expect(cloned?.session.lineage).toEqual({ parentSessionId: "root", parentEntryId: head.id });
  });

  it("children() and forest() read the DAG from lineage", () => {
    const store = freshStore();
    store.appendMessage("root", { role: "user", content: "u1", mode: "normal" });
    const head = store.appendMessage("root", { role: "assistant", content: "a1", mode: "normal" });
    const child = store.clone("root");
    const kids = store.children("root");
    expect(kids).toHaveLength(1);
    expect(kids[0]?.sessionId).toBe(child?.newId);
    expect(kids[0]?.parentEntryId).toBe(head.id);

    const forest = store.forest();
    const rootNode = forest.find((node) => node.id === "root");
    expect(rootNode?.children.map((node) => node.id)).toEqual([child?.newId]);
  });

  it("branchSummary set via appendMeta is exposed on the child branch", () => {
    const store = freshStore();
    store.appendMessage("root", { role: "user", content: "u", mode: "normal" });
    store.appendMessage("root", { role: "assistant", content: "a", mode: "normal" });
    const child = store.clone("root");
    store.appendMeta(child!.newId, {
      title: child!.session.title,
      routeId: null,
      modelIdOverride: null,
      branchSummary: "explored an alternate refactor"
    });
    expect(store.children("root")[0]?.branchSummary).toBe("explored an alternate refactor");
  });
});

describe("sessionLog — back-compat with legacy flat .json", () => {
  it("loads and lists a legacy record; /fork can still target a synthetic entry id", () => {
    const store = freshStore();
    const legacy = {
      id: "old",
      title: "Legacy chat",
      routeId: "r",
      modelIdOverride: null,
      messages: [
        { role: "user", content: "legacy-1" },
        { role: "assistant", content: "legacy-a" }
      ],
      turnCount: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    writeFileSync(join(store.directory, "old.json"), JSON.stringify(legacy), "utf8");
    const loaded = store.load("old");
    expect(loaded?.legacy).toBe(true);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.entryIds[0]).toBe("old:m0");
    expect(store.list().some((summary) => summary.id === "old")).toBe(true);

    const forked = store.fork("old", "old:m0");
    expect(forked?.session.messages.map((message) => message.content)).toEqual(["legacy-1"]);
    expect(forked?.session.legacy).toBe(false); // the fork is a native jsonl session
  });

  it("migration: seeding a jsonl for a legacy id preserves the full history (load prefers jsonl)", () => {
    const store = freshStore();
    const legacy = {
      id: "mig",
      title: "Migrate me",
      routeId: null,
      modelIdOverride: null,
      messages: [
        { role: "user", content: "old-1" },
        { role: "assistant", content: "old-a" }
      ],
      turnCount: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    writeFileSync(join(store.directory, "mig.json"), JSON.stringify(legacy), "utf8");
    const migrated = store.load("mig");
    // Simulate switchToSession → seedLog: re-write the full history into the log.
    store.appendMeta("mig", { title: migrated!.title, routeId: null, modelIdOverride: null });
    for (const message of migrated!.messages) {
      store.appendMessage("mig", { role: message.role, content: message.content, mode: "normal" });
    }
    // A NEW turn appended after migration chains onto the full history.
    store.appendMessage("mig", { role: "user", content: "new-1", mode: "normal" });
    const reloaded = store.load("mig");
    expect(reloaded?.legacy).toBe(false); // now a native jsonl session
    expect(reloaded?.messages.map((message) => message.content)).toEqual(["old-1", "old-a", "new-1"]);
  });
});
