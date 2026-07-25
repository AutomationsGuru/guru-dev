import { describe, expect, it } from "vitest";

import {
  injectSystemReminders,
  DEFAULT_REMINDER_LIMIT,
  DEFAULT_REMINDER_TEXT_MAX,
  type SystemReminder
} from "../../src/session/systemReminderInjector.js";

const r = (id: string, text = `text-${id}`, trigger = "boot"): SystemReminder => ({ id, text, trigger });

describe("injectSystemReminders — no duplicate ids", () => {
  it("drops a candidate whose id already exists in `existing`", () => {
    const existing = [r("a"), r("b")];
    const candidates = [r("b", "second b"), r("c")];

    const result = injectSystemReminders(candidates, existing);

    expect(result.reminders.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(result.droppedIds).toEqual(["b"]);
    // The existing reminder wins — the duplicate candidate text is discarded.
    expect(result.reminders.find((x) => x.id === "b")?.text).toBe("text-b");
  });

  it("drops a candidate that duplicates an earlier candidate in the same batch", () => {
    const candidates = [r("x", "first"), r("x", "second"), r("y")];

    const result = injectSystemReminders(candidates);

    expect(result.reminders.map((x) => x.id)).toEqual(["x", "y"]);
    expect(result.droppedIds).toEqual(["x"]);
    expect(result.reminders.find((x) => x.id === "x")?.text).toBe("first");
  });

  it("deduplicates ids already present in `existing` against each other too", () => {
    const existing = [r("a"), r("a", "dup")];

    const result = injectSystemReminders([r("b")], existing);

    expect(result.reminders.map((x) => x.id)).toEqual(["a", "b"]);
    expect(result.droppedIds).toEqual([]);
  });
});

describe("injectSystemReminders — append and shape", () => {
  it("appends new candidates after existing in insertion order", () => {
    const result = injectSystemReminders([r("c"), r("d")], [r("a"), r("b")]);

    expect(result.reminders.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.reminders.every((x) => typeof x.trigger === "string")).toBe(true);
  });

  it("returns an empty result for empty inputs without throwing", () => {
    expect(injectSystemReminders([], [])).toEqual({ reminders: [], droppedIds: [] });
    expect(injectSystemReminders([])).toEqual({ reminders: [], droppedIds: [] });
  });

  it("never mutates the caller's input arrays or objects", () => {
    const existing = [r("a")];
    const candidates = [r("b")];
    const existingSnapshot = existing.map((x) => ({ ...x }));
    const candidatesSnapshot = candidates.map((x) => ({ ...x }));

    injectSystemReminders(candidates, existing);

    expect(existing).toEqual(existingSnapshot);
    expect(candidates).toEqual(candidatesSnapshot);
  });
});

describe("injectSystemReminders — bounded", () => {
  it("trims the most recently appended candidates when the limit is exceeded", () => {
    const existing = [r("a"), r("b")];
    const candidates = [r("c"), r("d"), r("e")];

    const result = injectSystemReminders(candidates, existing, { limit: 3 });

    // Existing reminders survive; the newest candidate is trimmed.
    expect(result.reminders.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("honors the default reminder limit, keeping the first entries in insertion order", () => {
    const many: SystemReminder[] = Array.from({ length: DEFAULT_REMINDER_LIMIT + 5 }, (_, i) =>
      r(`id-${i}`)
    );

    const result = injectSystemReminders(many);

    expect(result.reminders.length).toBe(DEFAULT_REMINDER_LIMIT);
    // Insertion order is preserved; overflow trims the tail (newest candidates).
    expect(result.reminders[0]!.id).toBe(`id-0`);
    expect(result.reminders[result.reminders.length - 1]!.id).toBe(`id-${DEFAULT_REMINDER_LIMIT - 1}`);
  });

  it("truncates reminder text longer than textMax and preserves shorter text verbatim", () => {
    const longText = "x".repeat(DEFAULT_REMINDER_TEXT_MAX + 50);
    const short = r("short", "ok");

    const result = injectSystemReminders([r("long", longText), short], [], { textMax: 8 });

    const long = result.reminders.find((x) => x.id === "long");
    expect(long?.text.length).toBe(8);
    expect(long?.text.endsWith("…")).toBe(true);
    expect(result.reminders.find((x) => x.id === "short")?.text).toBe("ok");
  });

  it("falls back to defaults when limit/textMax are non-positive or non-finite", () => {
    const many = Array.from({ length: DEFAULT_REMINDER_LIMIT + 1 }, (_, i) => r(`id-${i}`));
    const longText = "y".repeat(DEFAULT_REMINDER_TEXT_MAX + 10);

    const fromLimit = injectSystemReminders(many, [], { limit: -1 });
    expect(fromLimit.reminders.length).toBe(DEFAULT_REMINDER_LIMIT);

    const fromText = injectSystemReminders([r("long", longText)], [], { textMax: Number.NaN });
    const long = fromText.reminders.find((x) => x.id === "long");
    expect(long?.text.length).toBe(DEFAULT_REMINDER_TEXT_MAX);
  });
});
