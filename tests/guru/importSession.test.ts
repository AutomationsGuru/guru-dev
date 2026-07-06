import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionLogStore } from "../../src/guru/sessionLog.js";
import {
  claudeProjectSlug,
  discoverLatestSession,
  importExternalSession,
  mapClaudeTranscript,
  mapPiTranscript,
  piBucketName
} from "../../src/guru/importSession.js";

let n = 0;
const dirs: string[] = [];
function freshDir(prefix: string): string {
  const dir = join(tmpdir(), `guru-imp-${prefix}-${process.pid}-${n++}`);
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const jsonl = (...objs: unknown[]): string => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";

// ---------------------------------------------------------------------------
// Claude Code mapper
// ---------------------------------------------------------------------------
describe("mapClaudeTranscript — Claude Code JSONL → guru turns", () => {
  const transcript = jsonl(
    { type: "user", isMeta: false, message: { role: "user", content: "Explain the router" }, timestamp: "2026-07-01T20:16:44.591Z", uuid: "u1" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The router picks a route." }] }, uuid: "a1", timestamp: "2026-07-01T20:16:50Z" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] }, uuid: "a2", timestamp: "2026-07-01T20:16:51Z" },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] }, uuid: "u2", timestamp: "2026-07-01T20:16:52Z" },
    { type: "user", isMeta: true, message: { role: "user", content: "<command-name>/mcp</command-name>" }, uuid: "u3" },
    { type: "attachment", message: { role: "user", content: "hook stdout noise" }, uuid: "at1" },
    { type: "ai-title", aiTitle: "Router" }
  );

  it("keeps real user + assistant turns, merges consecutive assistant lines, annotates tools", () => {
    const conv = mapClaudeTranscript(transcript);
    expect(conv.harness).toBe("claude");
    expect(conv.sourceLabel).toBe("Claude Code");
    expect(conv.createdAt).toBe("2026-07-01T20:16:44.591Z");
    expect(conv.messages).toEqual([
      { role: "user", content: "Explain the router" },
      { role: "assistant", content: "The router picks a route.\n[used tools: Read]" }
    ]);
  });

  it("skips tool_result user lines, isMeta command echoes, and all bookkeeping types", () => {
    const conv = mapClaudeTranscript(transcript);
    // tool_result (u2), isMeta (u3), attachment (at1), ai-title => 4 skipped.
    expect(conv.skipped).toBe(4);
    expect(JSON.stringify(conv.messages)).not.toContain("file contents"); // tool output dropped
    expect(JSON.stringify(conv.messages)).not.toContain("/mcp"); // command echo dropped
  });

  it("tolerates malformed / partial lines without aborting", () => {
    const withGarbage = `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-07-01T00:00:00Z"}\n{bad json\n`;
    const conv = mapClaudeTranscript(withGarbage);
    expect(conv.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

// ---------------------------------------------------------------------------
// Pi mapper
// ---------------------------------------------------------------------------
describe("mapPiTranscript — Pi v3 JSONL → guru turns", () => {
  const transcript = jsonl(
    { type: "session", version: 3, id: "s1", timestamp: "2026-07-01T20:19:06.789Z", cwd: "D:\\.projects\\x" },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-07-01T20:19:30Z", provider: "sakana", modelId: "fugu-ultra" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-07-01T20:19:30Z", thinkingLevel: "high" },
    { type: "message", id: "u1", parentId: "t1", timestamp: "2026-07-01T20:20:34Z", message: { role: "user", content: [{ type: "text", text: "Reconcile the ledger" }] } },
    // An ABANDONED branch child of u1 (earlier in file) — must NOT appear on the active path.
    { type: "message", id: "a1b", parentId: "u1", timestamp: "2026-07-01T20:20:40Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned branch reply" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T20:20:57Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "On it." }, { type: "toolCall", id: "tc1", name: "read", arguments: {} }], model: "fugu-ultra" } },
    { type: "message", id: "tr1", parentId: "a1", timestamp: "2026-07-01T20:21:00Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "ledger rows" }], isError: false } }
  );

  it("reconstructs the ACTIVE parentId path, drops thinking, annotates toolCalls, labels the model", () => {
    const conv = mapPiTranscript(transcript);
    expect(conv.harness).toBe("pi");
    expect(conv.sourceLabel).toBe("Pi · fugu-ultra");
    expect(conv.createdAt).toBe("2026-07-01T20:19:06.789Z");
    expect(conv.messages).toEqual([
      { role: "user", content: "Reconcile the ledger" },
      { role: "assistant", content: "On it.\n[used tools: read]" }
    ]);
  });

  it("excludes the abandoned branch (tip = last message, walk parentId back)", () => {
    const conv = mapPiTranscript(transcript);
    expect(JSON.stringify(conv.messages)).not.toContain("abandoned branch");
  });

  it("skips control records (model_change / thinking_level_change) and toolResult output", () => {
    const conv = mapPiTranscript(transcript);
    expect(JSON.stringify(conv.messages)).not.toContain("ledger rows"); // toolResult dropped
    expect(conv.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
describe("discovery — cwd → dir mapping + newest-by-mtime", () => {
  it("computes the exact Claude slug and Pi bucket for a Windows cwd", () => {
    expect(claudeProjectSlug("D:\\.projects\\guruharness")).toBe("D---projects-guruharness");
    expect(piBucketName("D:\\.projects\\guruharness")).toBe("--D--.projects-guruharness--");
  });

  it("finds the most recently ACTIVE session in the cwd-mapped dir", () => {
    const home = freshDir("home");
    const cwd = "D:\\proj\\demo";
    const bucket = join(home, ".pi", "agent", "sessions", piBucketName(cwd));
    mkdirSync(bucket, { recursive: true });
    const older = join(bucket, "2026-01-01_a.jsonl");
    const newer = join(bucket, "2026-02-01_b.jsonl");
    writeFileSync(older, "{}\n");
    writeFileSync(newer, "{}\n");
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    expect(discoverLatestSession("pi", { home, cwd })).toBe(newer);
  });

  it("falls back to scanning all buckets when the cwd bucket is absent", () => {
    const home = freshDir("home");
    const other = join(home, ".claude", "projects", "some-other-project");
    mkdirSync(other, { recursive: true });
    const file = join(other, "sess.jsonl");
    writeFileSync(file, "{}\n");
    // cwd maps to a slug with no dir → fallback finds the only file anywhere.
    expect(discoverLatestSession("claude", { home, cwd: "D:\\nowhere" })).toBe(file);
  });

  it("returns null when nothing exists", () => {
    const home = freshDir("home");
    expect(discoverLatestSession("pi", { home, cwd: "D:\\x" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end import (redaction + durable guru session + import-only)
// ---------------------------------------------------------------------------
describe("importExternalSession — foreign transcript → durable guru session", () => {
  function storeIn(dir: string) {
    let i = 0;
    return createSessionLogStore({ directory: dir, now: () => new Date(Date.UTC(2026, 6, 5)), newId: () => `imp-${i++}` });
  }

  it("creates a guru session: systemPrompt is message[0]+banner, turns follow, read-only", () => {
    const home = freshDir("home");
    const cwd = "D:\\proj";
    const bucket = join(home, ".pi", "agent", "sessions", piBucketName(cwd));
    mkdirSync(bucket, { recursive: true });
    writeFileSync(
      join(bucket, "2026-07-01_s.jsonl"),
      jsonl(
        { type: "session", version: 3, id: "s1", timestamp: "2026-07-01T20:19:06Z", cwd },
        { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T20:20:00Z", message: { role: "user", content: [{ type: "text", text: "hello pi" }] } },
        { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T20:20:10Z", message: { role: "assistant", content: [{ type: "text", text: "hi from pi" }], model: "fugu-ultra" } }
      )
    );
    const store = storeIn(freshDir("store"));
    const result = importExternalSession("pi", store, { cwd, home, systemPrompt: "GURU SYSTEM PROMPT" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.imported).toBe(2);
    expect(result.summary.sourceLabel).toBe("Pi · fugu-ultra");
    const msgs = result.session.messages;
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toContain("GURU SYSTEM PROMPT"); // instructions preserved
    expect(msgs[0]?.content).toContain("Read-only import"); // provenance banner
    expect(msgs[0]?.content).toContain("nothing from the other harness was re-executed");
    expect(msgs.slice(1)).toEqual([
      { role: "user", content: "hello pi" },
      { role: "assistant", content: "hi from pi" }
    ]);
    // Durable: reloading the session id returns the same history.
    expect(store.load(result.session.id)?.messages.length).toBe(3);
  });

  it("REDACTS secret-shaped values from foreign content before persisting (presence-over-value)", () => {
    const home = freshDir("home");
    const cwd = "D:\\proj";
    const dir = join(home, ".claude", "projects", claudeProjectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "s.jsonl"),
      jsonl(
        { type: "user", message: { role: "user", content: "my key is ghp_abcdefghijklmnopqrstuvwxyz0123456789 keep it safe" }, timestamp: "2026-07-01T00:00:00Z", uuid: "u1" },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, uuid: "a1", timestamp: "2026-07-01T00:00:01Z" }
      )
    );
    const store = storeIn(freshDir("store"));
    const result = importExternalSession("claude", store, { cwd, home, systemPrompt: "SYS" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.redactedMessages).toBe(1);
    expect(result.summary.redactionKinds).toContain("github-token");
    const persisted = JSON.stringify(store.load(result.session.id)?.messages);
    expect(persisted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789"); // value gone
    expect(persisted).toContain("[redacted:secret-shape]"); // placeholder present
  });

  it("shape-scrubs the banner label + title (foreign model/text) before they persist", () => {
    const home = freshDir("home");
    const cwd = "D:\\proj";
    const bucket = join(home, ".pi", "agent", "sessions", piBucketName(cwd));
    mkdirSync(bucket, { recursive: true });
    // A hostile/corrupt transcript smuggles a secret shape into message.model (→
    // the source label) AND into the first user turn (→ the derived title).
    const leaked = "sk-ant-abcdefghijklmnop0123456789";
    writeFileSync(
      join(bucket, "2026-07-01_s.jsonl"),
      jsonl(
        { type: "session", version: 3, id: "s1", timestamp: "2026-07-01T20:19:06Z", cwd },
        { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T20:20:00Z", message: { role: "user", content: [{ type: "text", text: `title with ${leaked} inside` }] } },
        { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T20:20:10Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: `evil-${leaked}` } }
      )
    );
    const store = storeIn(freshDir("store"));
    const result = importExternalSession("pi", store, { cwd, home, systemPrompt: "SYS" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Neither the banner (message[0]), the meta title, nor the summary label may
    // carry the secret-shaped value in cleartext.
    const reloaded = store.load(result.session.id);
    const persisted = JSON.stringify(reloaded);
    expect(persisted).not.toContain(leaked);
    expect(result.summary.sourceLabel).not.toContain(leaked);
    expect(result.summary.sourcePath).not.toContain(leaked);
    expect(reloaded?.messages[0]?.content).toContain("SYS"); // system prompt still intact
  });

  it("returns ok:false when the transcript has no importable turns", () => {
    const home = freshDir("home");
    const cwd = "D:\\proj";
    const dir = join(home, ".claude", "projects", claudeProjectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), jsonl({ type: "ai-title", aiTitle: "empty" }, { type: "attachment", uuid: "x" }));
    const store = storeIn(freshDir("store"));
    const result = importExternalSession("claude", store, { cwd, home, systemPrompt: "SYS" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no importable turns");
  });

  it("returns ok:false when no session file exists", () => {
    const home = freshDir("home");
    const store = storeIn(freshDir("store"));
    const result = importExternalSession("pi", store, { cwd: "D:\\x", home, systemPrompt: "SYS" });
    expect(result.ok).toBe(false);
  });
});
