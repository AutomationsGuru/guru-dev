import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { readQuestionAnswer, readAskQuestions } from "../../src/tui/askPrompt.js";
import { isInteractionGateOpen } from "../../src/tui/interactionGate.js";

function collect(output: PassThrough): string {
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer | string) => {
    chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  });
  return new Promise<string>((resolve) => {
    // drain after a short settle — tests resolve the prompt first
    setImmediate(() => resolve(Buffer.concat(chunks).toString("utf8")));
  }) as unknown as string;
}

describe("readQuestionAnswer", () => {
  it("selects by digit and closes the interaction gate", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: string[] = [];
    output.on("data", (c) => frames.push(String(c)));

    const pending = readQuestionAnswer(
      { question: "Pick one?", options: ["Alpha", "Beta", "Gamma"] },
      { input, output, isTty: true }
    );

    // Gate must be open while waiting.
    expect(isInteractionGateOpen()).toBe(true);

    // Allow the listener to attach.
    await new Promise((r) => setImmediate(r));
    input.write("2"); // pick Beta

    const answer = await pending;
    expect(answer).toEqual(["Beta"]);
    expect(isInteractionGateOpen()).toBe(false);
    expect(frames.join("")).toContain("Pick one?");
    expect(frames.join("")).toContain("Beta");
  });

  it("Enter confirms the highlighted option (default first)", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = readQuestionAnswer(
      { question: "Ship it?", options: ["Yes", "No"] },
      { input, output, isTty: true }
    );
    await new Promise((r) => setImmediate(r));
    input.write("\r");
    await expect(pending).resolves.toEqual(["Yes"]);
  });

  it("Esc cancels with an empty answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = readQuestionAnswer(
      { question: "Cancel me?", options: ["A", "B"] },
      { input, output, isTty: true }
    );
    await new Promise((r) => setImmediate(r));
    // Double-ESC is decoded immediately as escape (lone ESC needs grace).
    input.write("\x1b\x1b");
    await expect(pending).resolves.toEqual([]);
    expect(isInteractionGateOpen()).toBe(false);
  });

  it("non-TTY returns empty without hanging", async () => {
    await expect(
      readQuestionAnswer({ question: "?", options: ["A", "B"] }, { isTty: false })
    ).resolves.toEqual([]);
  });

  it("multi-select toggles with space and submits with enter", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = readQuestionAnswer(
      { question: "Pick many?", options: ["A", "B", "C"], is_multi_select: true },
      { input, output, isTty: true }
    );
    await new Promise((r) => setImmediate(r));
    input.write(" "); // toggle A
    await new Promise((r) => setImmediate(r));
    input.write("\x1b[B"); // down to B
    await new Promise((r) => setImmediate(r));
    input.write(" "); // toggle B
    await new Promise((r) => setImmediate(r));
    input.write("\r");
    await expect(pending).resolves.toEqual(["A", "B"]);
  });
});

describe("readAskQuestions", () => {
  it("asks each question in sequence", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = readAskQuestions(
      [
        { question: "Q1?", options: ["One", "Two"] },
        { question: "Q2?", options: ["X", "Y"] }
      ],
      { input, output, isTty: true }
    );
    await new Promise((r) => setImmediate(r));
    input.write("1");
    await new Promise((r) => setImmediate(r));
    // second question
    await new Promise((r) => setImmediate(r));
    input.write("2");
    await expect(pending).resolves.toEqual([["One"], ["Y"]]);
  });
});

// silence unused helper if collect is unused — keep for future frame asserts
void collect;
