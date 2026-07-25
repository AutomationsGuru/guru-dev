import { describe, expect, it } from "vitest";

import { createNotifier, renderOscNotification } from "../../src/tui/notify.js";

describe("renderOscNotification", () => {
  it("renders an OSC-9 sequence with title and body", () => {
    const seq = renderOscNotification({ title: "Build", body: "tests passed" });
    expect(seq).toContain("Build");
    expect(seq).toContain("tests passed");
    // OSC 9 ; <text> ST
    expect(seq.startsWith("\x1b]9;")).toBe(true);
    expect(seq.endsWith("\x1b\\")).toBe(true);
  });

  it("strips control characters from title and body (no escape-sequence injection)", () => {
    const seq = renderOscNotification({ title: "hi\x1b]9;evil\x07", body: "x\ny\rz" });
    expect(seq).not.toContain("evil");
    expect(seq).not.toContain("\n");
    expect(seq).not.toContain("\r");
  });

  it("bounds long text so the terminal sequence stays small", () => {
    const seq = renderOscNotification({ title: "t".repeat(500), body: "b".repeat(5000) });
    expect(seq.length).toBeLessThan(1200);
  });
});

describe("createNotifier", () => {
  it("delivers to a writable stream when the terminal supports OSC", () => {
    const writes: string[] = [];
    const notifier = createNotifier({
      stream: { write: (chunk: string) => { writes.push(chunk); return true; } },
      isTty: true,
      termProgram: "iTerm.app"
    });
    const result = notifier.notify({ title: "Guru", body: "done" });
    expect(result.delivered).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("done");
  });

  it("degrades silently on a non-TTY stream (no throw, no write)", () => {
    const writes: string[] = [];
    const notifier = createNotifier({
      stream: { write: (chunk: string) => { writes.push(chunk); return true; } },
      isTty: false
    });
    const result = notifier.notify({ title: "Guru", body: "done" });
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/tty|unsupported/i);
    expect(writes).toHaveLength(0);
  });

  it("degrades silently when the stream write throws", () => {
    const notifier = createNotifier({
      stream: { write: () => { throw new Error("EIO"); } },
      isTty: true,
      termProgram: "iTerm.app"
    });
    expect(() => notifier.notify({ title: "G", body: "b" })).not.toThrow();
    expect(notifier.notify({ title: "G", body: "b" }).delivered).toBe(false);
  });

  it("reports unsupported on terminals known not to implement OSC-9", () => {
    const notifier = createNotifier({
      stream: { write: () => true },
      isTty: true,
      termProgram: "unsupported-term-xyz",
      env: {}
    });
    const result = notifier.notify({ title: "G", body: "b" });
    expect(result.delivered).toBe(false);
  });
});
