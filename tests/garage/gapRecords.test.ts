import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryStore } from "../../src/memory/store.js";
import {
  deriveTrigger,
  evaluateAndClose,
  evaluateGapTrigger,
  loadGapRecords,
  makeGapRecord,
  saveGapRecords,
  upsertGapRecords,
  type GapTriggerProbe
} from "../../src/garage/gapRecords.js";

const probe: GapTriggerProbe = {
  toolPresent: (id) => id === "web-fetch",
  cmdPresent: (name) => name === "git"
};

let n = 0;
const dirs: string[] = [];
function freshMemory() {
  const directory = join(tmpdir(), `guru-gap-${process.pid}-${n++}`);
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  return createFileMemoryStore({ directory, now: () => new Date(Date.UTC(2026, 6, 5)) });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gap trigger evaluation (presence mini-language)", () => {
  it("evaluates tool: / cmd: / always / empty", () => {
    expect(evaluateGapTrigger("tool:web-fetch", probe)).toBe(true);
    expect(evaluateGapTrigger("tool:missing", probe)).toBe(false);
    expect(evaluateGapTrigger("cmd:git", probe)).toBe(true);
    expect(evaluateGapTrigger("cmd:nope", probe)).toBe(false);
    expect(evaluateGapTrigger("always", probe)).toBe(true);
    expect(evaluateGapTrigger("", probe)).toBe(false);
  });

  it("deriveTrigger points at the native tool that would cover the need", () => {
    expect(deriveTrigger("fetch a web page")).toBe("tool:fetch-a-web-page");
  });
});

describe("gap records — write, re-evaluate, close (§11 anti-obsolescence)", () => {
  it("makeGapRecord carries a presence trigger", () => {
    const record = makeGapRecord("web fetch", "build", "no native tool yet", "2026-07-05T00:00:00.000Z");
    expect(record.move).toBe("build");
    expect(record.trigger).toBe("tool:web-fetch");
  });

  it("ACCEPTANCE: a record whose trigger is now satisfied CLOSES; others stay open", () => {
    const closed = makeGapRecord("web fetch", "build", "n", "t"); // trigger tool:web-fetch → present
    const open = makeGapRecord("send slack message", "attach", "n", "t"); // trigger tool:send-slack-message → absent
    const result = evaluateAndClose([closed, open], probe);
    expect(result.closed.map((r) => r.capability)).toEqual(["web fetch"]);
    expect(result.open.map((r) => r.capability)).toEqual(["send slack message"]);
  });

  it("persists + reloads gap records through the memory organ", () => {
    const memory = freshMemory();
    const records = [makeGapRecord("web fetch", "build", "n", "t"), makeGapRecord("read pdf", "learn", "n", "t")];
    saveGapRecords(memory, records);
    const loaded = loadGapRecords(memory);
    expect(loaded.map((r) => r.capability).sort()).toEqual(["read pdf", "web fetch"]);
  });

  it("upsert dedupes by id (an existing gap is not duplicated)", () => {
    const a = makeGapRecord("web fetch", "build", "n", "t");
    const merged = upsertGapRecords([a], [makeGapRecord("web fetch", "build", "n2", "t2"), makeGapRecord("read pdf", "learn", "n", "t")]);
    expect(merged).toHaveLength(2);
  });
});
