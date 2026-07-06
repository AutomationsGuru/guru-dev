import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createConversationStore,
  deriveConversationTitle,
  resolveStoreDirectory,
  type ConversationRecord
} from "../../src/guru/conversationStore.js";

function tempStore() {
  const directory = mkdtempSync(join(tmpdir(), "guru-store-"));
  return { directory, store: createConversationStore({ directory }) };
}

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "Test session",
    routeId: "zai/glm-5-turbo",
    modelIdOverride: null,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ],
    turnCount: 1,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:05:00.000Z",
    ...overrides
  };
}

describe("conversation store", () => {
  it("round-trips a record: save -> load", () => {
    const { directory, store } = tempStore();
    try {
      const rec = record();
      store.save(rec);
      const loaded = store.load(rec.id);

      expect(loaded).toEqual(rec);
      expect(loaded?.messages).toHaveLength(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists summaries newest-first by updatedAt", () => {
    const { directory, store } = tempStore();
    try {
      store.save(record({ id: "aaaaaaaa-0000-0000-0000-000000000001", title: "older", updatedAt: "2026-07-01T09:00:00.000Z" }));
      store.save(record({ id: "bbbbbbbb-0000-0000-0000-000000000002", title: "newer", updatedAt: "2026-07-01T12:00:00.000Z" }));

      const list = store.list();
      expect(list.map((entry) => entry.title)).toEqual(["newer", "older"]);
      expect(list[0]).toMatchObject({ turnCount: 1, routeId: "zai/glm-5-turbo" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns undefined for a missing id and [] for an empty store", () => {
    const { directory, store } = tempStore();
    try {
      expect(store.load("nope")).toBeUndefined();
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips corrupt/invalid files instead of failing the list", () => {
    const { directory, store } = tempStore();
    try {
      store.save(record({ id: "cccccccc-0000-0000-0000-000000000003", title: "valid" }));
      writeFileSync(join(directory, "broken.json"), "{ not json", "utf8");
      writeFileSync(join(directory, "wrongshape.json"), JSON.stringify({ foo: "bar" }), "utf8");

      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe("valid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("defaults the store directory under the user home (not the repo)", () => {
    const dir = resolveStoreDirectory();
    expect(dir.replace(/\\/gu, "/")).toContain("/.guruharness/sessions");
    expect(dir.replace(/\\/gu, "/")).not.toContain("/guruharness/main/src");
  });
});

describe("deriveConversationTitle", () => {
  it("uses the first user message, trimmed and length-capped", () => {
    expect(deriveConversationTitle([{ role: "system", content: "sys" }, { role: "user", content: "  Fix the   build please  " }])).toBe(
      "Fix the build please"
    );
    const long = "x".repeat(200);
    expect(deriveConversationTitle([{ role: "user", content: long }]).length).toBeLessThanOrEqual(60);
  });

  it("falls back to a placeholder when there is no user message", () => {
    expect(deriveConversationTitle([{ role: "system", content: "sys" }])).toBe("Untitled session");
  });
});
