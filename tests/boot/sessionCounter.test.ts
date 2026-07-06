import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { incrementSessionCounter, readSessionCounter } from "../../src/boot/sessionCounter.js";

let n = 0;
const dirs: string[] = [];
function freshDir() {
  const directory = join(tmpdir(), `guru-sess-${process.pid}-${n++}`);
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  return directory;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session counter", () => {
  it("reads 0 before the first boot", () => {
    expect(readSessionCounter({ directory: freshDir() })).toBe(0);
  });

  it("increments monotonically and persists across reads", () => {
    const directory = freshDir();
    const now = () => new Date(Date.UTC(2026, 6, 5));
    expect(incrementSessionCounter({ directory, now })).toBe(1);
    expect(incrementSessionCounter({ directory, now })).toBe(2);
    expect(incrementSessionCounter({ directory, now })).toBe(3);
    expect(readSessionCounter({ directory })).toBe(3);
    expect(existsSync(join(directory, "session-count.json"))).toBe(true);
  });

  it("a corrupt state file reads as 0 (never throws at boot)", () => {
    const directory = freshDir();
    // Write garbage where the counter lives.
    mkdirSync(directory, { recursive: true });
    rmSync(join(directory, "session-count.json"), { force: true });
    expect(readSessionCounter({ directory })).toBe(0);
  });
});
