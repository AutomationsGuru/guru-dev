import { describe, expect, it } from "vitest";

import { mayWrite } from '../../src/mandates/pathDenyUnderYolo.js';

describe("mayWrite", () => {
  it("denies a configured path even when YOLO is enabled", () => {
    expect(mayWrite("/etc/hosts", { yolo: true, denyPatterns: ["/etc"] })).toBe(false);
  });

  it("allows a path outside the configured deny patterns in YOLO", () => {
    expect(mayWrite("/workspace/notes.md", { yolo: true, denyPatterns: ["/etc"] })).toBe(true);
  });
});
