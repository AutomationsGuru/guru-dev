import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SHADOW_CHECKPOINT_LIMITS,
  PendingToolCallSchema,
  ShadowCheckpointSchema
} from '../../src/session/shadowCheckpoint.js';
import { createShadowCheckpointStore, looksSecretPath } from '../../src/session/shadowCheckpointStore.js';

describe("shadow checkpoint restore (IDEA-F96)", () => {
  let workspaceRoot: string;
  let storeRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "guru-shadow-ws-"));
    storeRoot = mkdtempSync(join(tmpdir(), "guru-shadow-store-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  });

  const enabledStore = (limits = DEFAULT_SHADOW_CHECKPOINT_LIMITS) =>
    createShadowCheckpointStore({ workspaceRoot, storeRoot, enabled: true, limits });

  describe("disabled path", () => {
    it("no-ops create/list/get/restore when enabled is false (default)", async () => {
      writeFileSync(join(workspaceRoot, "a.txt"), "before");
      const store = createShadowCheckpointStore({ workspaceRoot, storeRoot });

      expect(store.enabled).toBe(false);
      expect(await store.create({ paths: ["a.txt"], transcriptMessageCount: 3 })).toBeNull();
      expect(await store.list()).toEqual([]);
      expect(await store.get("any-id")).toBeNull();
      expect(await store.restore("any-id")).toBeNull();
      expect(readFileSync(join(workspaceRoot, "a.txt"), "utf8")).toBe("before");
    });
  });

  describe("create -> mutate -> restore", () => {
    it("restores prior file content after mutation", async () => {
      mkdirSync(join(workspaceRoot, "src"), { recursive: true });
      writeFileSync(join(workspaceRoot, "src/file.ts"), "original");
      writeFileSync(join(workspaceRoot, "keep.txt"), "untouched");

      const store = enabledStore();
      const created = await store.create({
        paths: [join(workspaceRoot, "src/file.ts")],
        transcriptMessageCount: 4,
        label: "before-edit",
        sessionId: "sess-1",
        pendingToolCall: { id: "tc-1", name: "edit", arguments: { path: "src/file.ts", content: "mutated" } }
      });

      expect(created).not.toBeNull();
      expect(created!.summary.entryCount).toBe(1);
      expect(created!.summary.hasPendingToolCall).toBe(true);
      expect(created!.checkpoint.transcriptMessageCount).toBe(4);

      writeFileSync(join(workspaceRoot, "src/file.ts"), "mutated-by-agent");

      const result = await store.restore(created!.checkpoint.id);

      expect(result).not.toBeNull();
      expect(result!.restored).toEqual(["src/file.ts"]);
      expect(result!.removed).toEqual([]);
      expect(result!.pendingToolCall).toEqual({
        id: "tc-1",
        name: "edit",
        arguments: { path: "src/file.ts", content: "mutated" }
      });
      expect(result!.transcriptMessageCount).toBe(4);
      expect(result!.label).toBe("before-edit");
      expect(readFileSync(join(workspaceRoot, "src/file.ts"), "utf8")).toBe("original");
      expect(readFileSync(join(workspaceRoot, "keep.txt"), "utf8")).toBe("untouched");
    });

    it("removes files the mutation created (absent at capture)", async () => {
      writeFileSync(join(workspaceRoot, "anchor.txt"), "anchor");

      const store = enabledStore();
      const created = await store.create({
        paths: [join(workspaceRoot, "newdir/created.txt")],
        transcriptMessageCount: 1
      });
      expect(created!.checkpoint.entries[0]?.existed).toBe(false);

      mkdirSync(join(workspaceRoot, "newdir"), { recursive: true });
      writeFileSync(join(workspaceRoot, "newdir/created.txt"), "agent wrote this");

      const result = await store.restore(created!.checkpoint.id);

      expect(result!.removed).toEqual(["newdir/created.txt"]);
      expect(() => readFileSync(join(workspaceRoot, "newdir/created.txt"), "utf8")).toThrow();
      expect(readFileSync(join(workspaceRoot, "anchor.txt"), "utf8")).toBe("anchor");
    });

    it("recreates files the mutation deleted", async () => {
      writeFileSync(join(workspaceRoot, "docs.md"), "keep-me");

      const store = enabledStore();
      const created = await store.create({
        paths: ["docs.md"],
        transcriptMessageCount: 2
      });

      rmSync(join(workspaceRoot, "docs.md"));

      const result = await store.restore(created!.checkpoint.id);
      expect(result!.restored).toEqual(["docs.md"]);
      expect(readFileSync(join(workspaceRoot, "docs.md"), "utf8")).toBe("keep-me");
    });

    it("restores executable mode bits", async () => {
      const scriptPath = join(workspaceRoot, "run.sh");
      writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
      chmodSync(scriptPath, 0o755);

      const store = enabledStore();
      const created = await store.create({ paths: [scriptPath], transcriptMessageCount: 0 });

      writeFileSync(scriptPath, "#!/bin/sh\necho changed\n");
      chmodSync(scriptPath, 0o644);

      await store.restore(created!.checkpoint.id);

      expect(statSync(scriptPath).mode & 0o777).toBe(0o755);
      expect(readFileSync(scriptPath, "utf8")).toContain("echo hi");
    });

    it("supports multi-file batches as one checkpoint unit", async () => {
      writeFileSync(join(workspaceRoot, "one.txt"), "one-before");
      writeFileSync(join(workspaceRoot, "two.txt"), "two-before");

      const store = enabledStore();
      const created = await store.create({
        paths: ["one.txt", "two.txt"],
        transcriptMessageCount: 5,
        pendingToolCall: { id: "tc-batch", name: "write", arguments: { files: ["one.txt", "two.txt"] } }
      });

      writeFileSync(join(workspaceRoot, "one.txt"), "one-after");
      rmSync(join(workspaceRoot, "two.txt"));

      const result = await store.restore(created!.checkpoint.id);

      expect([...result!.restored].sort()).toEqual(["one.txt", "two.txt"]);
      expect(readFileSync(join(workspaceRoot, "one.txt"), "utf8")).toBe("one-before");
      expect(readFileSync(join(workspaceRoot, "two.txt"), "utf8")).toBe("two-before");
      expect(result!.pendingToolCall?.id).toBe("tc-batch");
    });
  });

  describe("pending tool re-queue + transcript pointer", () => {
    it("returns pending tool call payload for operator re-propose", async () => {
      writeFileSync(join(workspaceRoot, "x.ts"), "v1");
      const pending = PendingToolCallSchema.parse({
        id: "call_abc",
        name: "write",
        arguments: { path: "x.ts", contents: "v2" }
      });

      const store = enabledStore();
      const created = await store.create({
        paths: ["x.ts"],
        transcriptMessageCount: 12,
        pendingToolCall: pending
      });

      writeFileSync(join(workspaceRoot, "x.ts"), "v2");
      const result = await store.restore(created!.checkpoint.id);

      expect(result!.pendingToolCall).toEqual(pending);
      expect(result!.transcriptMessageCount).toBe(12);
    });

    it("stores null pending tool call when omitted", async () => {
      writeFileSync(join(workspaceRoot, "y.ts"), "y");
      const store = enabledStore();
      const created = await store.create({ paths: ["y.ts"], transcriptMessageCount: 0 });
      expect(created!.checkpoint.pendingToolCall).toBeNull();
      const result = await store.restore(created!.checkpoint.id);
      expect(result!.pendingToolCall).toBeNull();
    });
  });

  describe("list + get", () => {
    it("lists checkpoints newest-first and get returns full record", async () => {
      writeFileSync(join(workspaceRoot, "a.txt"), "a");
      const store = enabledStore();

      const first = await store.create({ paths: ["a.txt"], transcriptMessageCount: 1, label: "first" });
      // Ensure distinct createdAt ordering under fast CI clocks.
      await new Promise((r) => setTimeout(r, 5));
      writeFileSync(join(workspaceRoot, "a.txt"), "b");
      const second = await store.create({ paths: ["a.txt"], transcriptMessageCount: 2, label: "second" });

      const listed = await store.list();
      expect(listed.length).toBe(2);
      expect(listed[0]!.id).toBe(second!.checkpoint.id);
      expect(listed[1]!.id).toBe(first!.checkpoint.id);

      const loaded = await store.get(first!.checkpoint.id);
      expect(loaded).not.toBeNull();
      expect(ShadowCheckpointSchema.parse(loaded).label).toBe("first");
    });

    it("get returns null for unknown or invalid ids", async () => {
      const store = enabledStore();
      expect(await store.get("not-a-real-id")).toBeNull();
      expect(await store.get("../escape")).toBeNull();
      expect(await store.restore("missing")).toBeNull();
    });
  });

  describe("safety bounds", () => {
    it("refuses secret-looking paths by name and never restores them", async () => {
      expect(looksSecretPath(".env")).toBe(true);
      expect(looksSecretPath("secrets/token.txt")).toBe(true);
      expect(looksSecretPath("id_rsa")).toBe(true);
      expect(looksSecretPath("src/app.ts")).toBe(false);

      writeFileSync(join(workspaceRoot, ".env"), "API_KEY=sk-test");
      writeFileSync(join(workspaceRoot, "ok.txt"), "ok");

      const store = enabledStore();
      const created = await store.create({
        paths: [".env", "ok.txt"],
        transcriptMessageCount: 0
      });

      expect(created!.checkpoint.skipped).toContain(".env");
      expect(created!.summary.entryCount).toBe(1);
      expect(created!.checkpoint.entries[0]?.relativePath).toBe("ok.txt");
    });

    it("refuses secret-shaped content via containsSecretValue", async () => {
      writeFileSync(join(workspaceRoot, "leaky.txt"), "Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz012345");
      writeFileSync(join(workspaceRoot, "safe.txt"), "plain text");

      const store = enabledStore();
      const created = await store.create({
        paths: ["leaky.txt", "safe.txt"],
        transcriptMessageCount: 0
      });

      expect(created!.checkpoint.skipped).toContain("leaky.txt");
      expect(created!.checkpoint.entries.map((e) => e.relativePath)).toEqual(["safe.txt"]);
    });

    it("skips paths that escape the workspace root", async () => {
      writeFileSync(join(workspaceRoot, "in.txt"), "in");
      const store = enabledStore();
      const created = await store.create({
        paths: ["in.txt", join(workspaceRoot, "..", "outside.txt"), "/etc/passwd"],
        transcriptMessageCount: 0
      });

      expect(created!.summary.entryCount).toBe(1);
      expect(created!.checkpoint.entries[0]?.relativePath).toBe("in.txt");
      expect(created!.checkpoint.skipped.length).toBeGreaterThanOrEqual(1);
    });

    it("never captures paths under .git", async () => {
      mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
      writeFileSync(join(workspaceRoot, ".git/config"), "[core]\n");
      writeFileSync(join(workspaceRoot, "src.ts"), "src");

      const store = enabledStore();
      const created = await store.create({
        paths: [".git/config", "src.ts"],
        transcriptMessageCount: 0
      });

      expect(created!.checkpoint.skipped).toContain(".git/config");
      expect(created!.checkpoint.entries.map((e) => e.relativePath)).toEqual(["src.ts"]);
    });

    it("rejects storeRoot pointed at project .git", () => {
      mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
      expect(() =>
        createShadowCheckpointStore({
          workspaceRoot,
          storeRoot: join(workspaceRoot, ".git"),
          enabled: true
        })
      ).toThrow(/\.git/);
    });

    it("enforces per-file byte cap", async () => {
      writeFileSync(join(workspaceRoot, "big.txt"), "x".repeat(200));
      writeFileSync(join(workspaceRoot, "small.txt"), "ok");

      const store = enabledStore({
        maxFileBytes: 50,
        maxCheckpointBytes: 16 * 1024 * 1024,
        maxCheckpoints: 32
      });
      const created = await store.create({
        paths: ["big.txt", "small.txt"],
        transcriptMessageCount: 0
      });

      expect(created!.checkpoint.skipped).toContain("big.txt");
      expect(created!.checkpoint.entries.map((e) => e.relativePath)).toEqual(["small.txt"]);
    });

    it("drops oldest checkpoints when retained count is exceeded (FIFO)", async () => {
      writeFileSync(join(workspaceRoot, "f.txt"), "v");
      const store = enabledStore({
        maxFileBytes: 1024 * 1024,
        maxCheckpointBytes: 16 * 1024 * 1024,
        maxCheckpoints: 2
      });

      const a = await store.create({ paths: ["f.txt"], transcriptMessageCount: 0, label: "a" });
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.create({ paths: ["f.txt"], transcriptMessageCount: 0, label: "b" });
      await new Promise((r) => setTimeout(r, 5));
      const c = await store.create({ paths: ["f.txt"], transcriptMessageCount: 0, label: "c" });

      const listed = await store.list();
      expect(listed.length).toBe(2);
      expect(listed.map((s) => s.id)).toEqual([c!.checkpoint.id, b!.checkpoint.id]);
      expect(await store.get(a!.checkpoint.id)).toBeNull();
    });
  });

  describe("unrelated work preservation", () => {
    it("never touches paths that were not snapshotted", async () => {
      writeFileSync(join(workspaceRoot, "snap.txt"), "snap-v1");
      writeFileSync(join(workspaceRoot, "user-work.txt"), "operator");

      const store = enabledStore();
      const created = await store.create({ paths: ["snap.txt"], transcriptMessageCount: 0 });

      writeFileSync(join(workspaceRoot, "snap.txt"), "snap-v2");
      writeFileSync(join(workspaceRoot, "user-work.txt"), "operator-edited");

      await store.restore(created!.checkpoint.id);

      expect(readFileSync(join(workspaceRoot, "snap.txt"), "utf8")).toBe("snap-v1");
      expect(readFileSync(join(workspaceRoot, "user-work.txt"), "utf8")).toBe("operator-edited");
    });
  });
});
