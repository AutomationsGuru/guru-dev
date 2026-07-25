import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SNAPSHOT_LIMITS,
  createSideSnapshotStore,
  looksSecretPath,
  restoreSideSnapshot
} from '../../src/runtime/sideSnapshot.js';

describe("side snapshot restore", () => {
  let workspaceRoot: string;
  let snapshotRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "guru-side-snap-ws-"));
    snapshotRoot = mkdtempSync(join(tmpdir(), "guru-side-snap-store-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(snapshotRoot, { recursive: true, force: true });
  });

  const store = (limits = DEFAULT_SNAPSHOT_LIMITS) => createSideSnapshotStore({ workspaceRoot, snapshotRoot, limits });

  describe("capture + restore-last", () => {
    it("restores modified file content and prunes directories emptied by the restore", async () => {
      mkdirSync(join(workspaceRoot, "src/nested"), { recursive: true });
      writeFileSync(join(workspaceRoot, "src/nested/file.txt"), "before");
      writeFileSync(join(workspaceRoot, "keep.txt"), "keep");

      const sideSnapshots = store();
      const batch = await sideSnapshots.captureBatch([join(workspaceRoot, "src/nested/file.txt")]);
      expect(batch).toMatchObject({ label: "manual", entryCount: 1, totalBytes: Buffer.byteLength("before") });

      writeFileSync(join(workspaceRoot, "src/nested/file.txt"), "after");

      const result = await sideSnapshots.restoreLast();

      expect(result).toMatchObject({ snapshotId: batch.snapshotId, restored: ["src/nested/file.txt"], removed: [], preserveCount: 1 });
      expect(readFileSync(join(workspaceRoot, "src/nested/file.txt"), "utf8")).toBe("before");
      // Restoring the only file under src/nested must not leave empty husks behind.
      expect(() => readFileSync(join(workspaceRoot, "keep.txt"), "utf8")).not.toThrow();
    });

    it("recreates files the mutation deleted", async () => {
      mkdirSync(join(workspaceRoot, "docs"), { recursive: true });
      writeFileSync(join(workspaceRoot, "docs/gone.md"), "original");

      const sideSnapshots = store();
      await sideSnapshots.captureBatch([join(workspaceRoot, "docs/gone.md")]);

      rmSync(join(workspaceRoot, "docs/gone.md"));

      const result = await sideSnapshots.restoreLast();

      expect(result.restored).toEqual(["docs/gone.md"]);
      expect(readFileSync(join(workspaceRoot, "docs/gone.md"), "utf8")).toBe("original");
    });

    it("removes files the mutation created and prunes their empty parent directories", async () => {
      writeFileSync(join(workspaceRoot, "anchor.txt"), "anchor");

      const sideSnapshots = store();
      await sideSnapshots.captureBatch([join(workspaceRoot, "newdir/created.txt")]);

      mkdirSync(join(workspaceRoot, "newdir"), { recursive: true });
      writeFileSync(join(workspaceRoot, "newdir/created.txt"), "agent wrote this");

      const result = await sideSnapshots.restoreLast();

      expect(result).toMatchObject({ restored: [], removed: ["newdir/created.txt"] });
      expect(() => readFileSync(join(workspaceRoot, "newdir/created.txt"), "utf8")).toThrow();
      // newdir only existed to hold the created file — it must be pruned, anchor.txt untouched.
      expect(() => readFileSync(join(workspaceRoot, "newdir"), "utf8")).toThrow();
      expect(readFileSync(join(workspaceRoot, "anchor.txt"), "utf8")).toBe("anchor");
    });

    it("restores executable mode bits captured with the file", async () => {
      const scriptPath = join(workspaceRoot, "run.sh");
      writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
      chmodSync(scriptPath, 0o755);

      const sideSnapshots = store();
      await sideSnapshots.captureBatch([scriptPath]);

      writeFileSync(scriptPath, "#!/bin/sh\necho changed\n");
      chmodSync(scriptPath, 0o644);

      await sideSnapshots.restoreLast();

      const { mode } = await import("node:fs").then((fs) => fs.statSync(scriptPath));
      expect(mode & 0o777).toBe(0o755);
      expect(readFileSync(scriptPath, "utf8")).toContain("echo hi");
    });

    it("restores the most recent batch, then the one before it on a second call", async () => {
      writeFileSync(join(workspaceRoot, "a.txt"), "v1");

      const sideSnapshots = store();
      const first = await sideSnapshots.captureBatch([join(workspaceRoot, "a.txt")]);
      writeFileSync(join(workspaceRoot, "a.txt"), "v2");
      const second = await sideSnapshots.captureBatch([join(workspaceRoot, "a.txt")]);
      writeFileSync(join(workspaceRoot, "a.txt"), "v3");

      const undoSecond = await sideSnapshots.restoreLast();
      expect(undoSecond.snapshotId).toBe(second.snapshotId);
      expect(readFileSync(join(workspaceRoot, "a.txt"), "utf8")).toBe("v2");

      const undoFirst = await sideSnapshots.restoreLast();
      expect(undoFirst.snapshotId).toBe(first.snapshotId);
      expect(readFileSync(join(workspaceRoot, "a.txt"), "utf8")).toBe("v1");
    });

    it("supports multi-file batches as one undo unit", async () => {
      writeFileSync(join(workspaceRoot, "one.txt"), "one-before");
      writeFileSync(join(workspaceRoot, "two.txt"), "two-before");

      const sideSnapshots = store();
      await sideSnapshots.captureBatch([join(workspaceRoot, "one.txt"), join(workspaceRoot, "two.txt")]);

      writeFileSync(join(workspaceRoot, "one.txt"), "one-after");
      rmSync(join(workspaceRoot, "two.txt"));

      const result = await sideSnapshots.restoreLast();

      expect([...result.restored].sort()).toEqual(["one.txt", "two.txt"]);
      expect(readFileSync(join(workspaceRoot, "one.txt"), "utf8")).toBe("one-before");
      expect(readFileSync(join(workspaceRoot, "two.txt"), "utf8")).toBe("two-before");
    });
  });

  describe("preservation on destructive restore (hard limit 1)", () => {
    it("records the overwritten current state as preserve entries so the mutation is recoverable", async () => {
      writeFileSync(join(workspaceRoot, "work.txt"), "v1");

      const sideSnapshots = store();
      await sideSnapshots.captureBatch([join(workspaceRoot, "work.txt")]);
      writeFileSync(join(workspaceRoot, "work.txt"), "v2-mutated");

      const result = await sideSnapshots.restoreLast();

      expect(result.preserveCount).toBe(1);
      const [preserved] = result.preserve;
      expect(preserved).toBeDefined();
      expect(preserved?.relativePath).toBe("work.txt");
      expect(preserved?.kind).toBe("file");
      expect(preserved?.existed).toBe(true);
      // The mutated bytes survive inside the snapshot record — restore is not destruction.
      const preservedPath = join(snapshotRoot, result.snapshotId, preserved?.snapshotPath ?? "");
      expect(readFileSync(preservedPath, "utf8")).toBe("v2-mutated");
      // And the entry content can be re-materialized through the typed record.
      const entries = await sideSnapshots.readEntries(result.snapshotId);
      const preserveEntry = entries.find((entry) => entry.relativePath === "work.txt" && entry.kind === "file" && entry.preservedFrom === "restore");
      expect(preserveEntry).toBeDefined();
    });
  });

  describe("secret hygiene (hard limit 3)", () => {
    it("refuses secret-looking paths by name without persisting anything", async () => {
      writeFileSync(join(workspaceRoot, ".env"), "TOKEN=abc123");

      const sideSnapshots = store();
      const batch = await sideSnapshots.captureBatch([join(workspaceRoot, ".env"), join(workspaceRoot, "fine.txt")]);

      expect(batch.skipped).toEqual([".env"]);
      // fine.txt was absent, so it records an absence marker — but no payload bytes.
      expect(batch.entryCount).toBe(1);
      const { readdirSync } = await import("node:fs");
      const persisted = readdirSync(join(snapshotRoot, batch.snapshotId, "entries"), { withFileTypes: true });
      expect(persisted.filter((dirent) => dirent.isFile())).toHaveLength(0);
    });

    it("refuses files whose contents match a secret shape", async () => {
      writeFileSync(join(workspaceRoot, "innocent-name.txt"), "config: sk-ant-abcdefghijklmnop1234567890");

      const sideSnapshots = store();
      const batch = await sideSnapshots.captureBatch([join(workspaceRoot, "innocent-name.txt")]);

      expect(batch.skipped).toEqual(["innocent-name.txt"]);
      expect(batch.entryCount).toBe(0);
    });

    it("refuses restore of tampered entries that point at secret-looking paths", async () => {
      writeFileSync(join(workspaceRoot, "ok.txt"), "ok");

      const sideSnapshots = store();
      const batch = await sideSnapshots.captureBatch([join(workspaceRoot, "ok.txt")]);

      // Forge an extra manifest entry pointing at a secret path.
      const manifestPath = join(snapshotRoot, batch.snapshotId, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { entries: Array<Record<string, unknown>> };
      manifest.entries.push({
        relativePath: "credentials.pem",
        kind: "file",
        existed: false,
        snapshotPath: null,
        sizeBytes: 0,
        mode: null,
        digest: null,
        preservedFrom: null
      });
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const result = await sideSnapshots.restoreLast();

      expect(result.restored).toEqual(["ok.txt"]);
      expect(result.skipped).toEqual(["credentials.pem"]);
    });

    it("exposes looksSecretPath for call-site preflight checks", () => {
      expect(looksSecretPath(".env")).toBe(true);
      expect(looksSecretPath("config/.env.local")).toBe(true);
      expect(looksSecretPath("certs/server.pem")).toBe(true);
      expect(looksSecretPath("id_rsa")).toBe(true);
      expect(looksSecretPath("src/runtime/sideSnapshot.ts")).toBe(false);
      expect(looksSecretPath("environment.ts")).toBe(false);
      expect(looksSecretPath("tokenizer.ts")).toBe(false);
    });
  });

  describe("safety refusals and no-ops", () => {
    it("treats unknown snapshot references as a no-op and never throws", async () => {
      writeFileSync(join(workspaceRoot, "file.txt"), "state");

      const result = await restoreSideSnapshot({ workspaceRoot, snapshotRoot, snapshotRef: "does-not-exist" });

      expect(result).toMatchObject({ restored: [], removed: [], skipped: [], preserveCount: 0 });
      expect(readFileSync(join(workspaceRoot, "file.txt"), "utf8")).toBe("state");
    });

    it("restoreLast on an empty store is a no-op", async () => {
      const sideSnapshots = store();

      const result = await sideSnapshots.restoreLast();

      expect(result).toMatchObject({ snapshotId: "", restored: [], removed: [], skipped: [] });
    });

    it("never touches workspace paths that were not snapshotted", async () => {
      writeFileSync(join(workspaceRoot, "snapshotted.txt"), "before");
      writeFileSync(join(workspaceRoot, "user-work.txt"), "do not touch");

      const sideSnapshots = store();
      await sideSnapshots.captureBatch([join(workspaceRoot, "snapshotted.txt")]);
      writeFileSync(join(workspaceRoot, "snapshotted.txt"), "after");

      await sideSnapshots.restoreLast();

      expect(readFileSync(join(workspaceRoot, "user-work.txt"), "utf8")).toBe("do not touch");
    });

    it("refuses paths outside the workspace root instead of snapshotting them", async () => {
      const outside = mkdtempSync(join(tmpdir(), "guru-side-snap-outside-"));
      try {
        writeFileSync(join(outside, "escape.txt"), "outside");

        const sideSnapshots = store();
        const batch = await sideSnapshots.captureBatch([join(outside, "escape.txt"), "../also-outside.txt"]);

        expect(batch.skipped).toHaveLength(2);
        expect(batch.entryCount).toBe(0);
        expect(readFileSync(join(outside, "escape.txt"), "utf8")).toBe("outside");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("skips manifest entries that would escape the workspace on restore", async () => {
      writeFileSync(join(workspaceRoot, "ok.txt"), "ok");

      const sideSnapshots = store();
      const batch = await sideSnapshots.captureBatch([join(workspaceRoot, "ok.txt")]);

      const manifestPath = join(snapshotRoot, batch.snapshotId, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { entries: Array<Record<string, unknown>> };
      manifest.entries.push({
        relativePath: "../evil.txt",
        kind: "file",
        existed: false,
        snapshotPath: null,
        sizeBytes: 0,
        mode: null,
        digest: null,
        preservedFrom: null
      });
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const result = await sideSnapshots.restoreLast();

      expect(result.skipped).toEqual(["../evil.txt"]);
      expect(() => readFileSync(join(workspaceRoot, "..", "evil.txt"), "utf8")).toThrow();
    });
  });

  describe("bounded size", () => {
    it("skips files that exceed the per-file byte cap", async () => {
      writeFileSync(join(workspaceRoot, "big.bin"), Buffer.alloc(2048, 7));

      const sideSnapshots = store({ maxFileBytes: 1024, maxSnapshotBytes: 64 * 1024, maxSnapshots: 16 });
      const batch = await sideSnapshots.captureBatch([join(workspaceRoot, "big.bin")]);

      expect(batch.skipped).toEqual(["big.bin"]);
      expect(batch.entryCount).toBe(0);
    });

    it("drops the oldest snapshots once the retained count limit is exceeded", async () => {
      const sideSnapshots = store({ maxFileBytes: 1024, maxSnapshotBytes: 64 * 1024, maxSnapshots: 2 });

      writeFileSync(join(workspaceRoot, "f.txt"), "one");
      const first = await sideSnapshots.captureBatch([join(workspaceRoot, "f.txt")]);
      writeFileSync(join(workspaceRoot, "f.txt"), "two");
      const second = await sideSnapshots.captureBatch([join(workspaceRoot, "f.txt")]);
      writeFileSync(join(workspaceRoot, "f.txt"), "three");
      const third = await sideSnapshots.captureBatch([join(workspaceRoot, "f.txt")]);

      const listed = await sideSnapshots.list();
      expect(listed.map((summary) => summary.snapshotId)).toEqual([third.snapshotId, second.snapshotId]);
      expect(listed.map((summary) => summary.snapshotId)).not.toContain(first.snapshotId);
    });
  });

  describe("listing", () => {
    it("lists newest-first summaries with entry counts", async () => {
      writeFileSync(join(workspaceRoot, "a.txt"), "a");

      const sideSnapshots = store();
      const batch = await sideSnapshots.captureBatch([join(workspaceRoot, "a.txt")], "turn-7");

      const listed = await sideSnapshots.list();

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ snapshotId: batch.snapshotId, label: "turn-7", entryCount: 1, skippedCount: 0 });
    });
  });
});
