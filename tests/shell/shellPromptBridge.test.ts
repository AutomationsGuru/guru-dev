import { describe, expect, it, vi } from "vitest";

import {
  createShellPromptBridge,
  parseLine,
  ShellPromptBridgeError
} from '../../src/shell/shellPromptBridge.js';
import { suggestToBuffer } from '../../src/shell/shellSuggestBuffer.js';

describe("parseLine", () => {
  it("parses an agent id plus prompt into a prompt intent", () => {
    const intent = parseLine(":guru fix the flaky resume test");
    expect(intent).toEqual({
      kind: "prompt",
      agent: "guru",
      prompt: "fix the flaky resume test"
    });
  });

  it("collapses internal whitespace and strips surrounding whitespace", () => {
    const intent = parseLine("   :ops    run   the   deploy  check  ");
    expect(intent).toEqual({
      kind: "prompt",
      agent: "ops",
      prompt: "run the deploy check"
    });
  });

  it("routes the :suggest meta-command to a suggest intent", () => {
    const intent = parseLine(":suggest guru resume the parked session");
    expect(intent).toEqual({
      kind: "suggest",
      agent: "guru",
      prompt: "resume the parked session"
    });
  });

  it("accepts an agent-only line as a prompt intent with an empty prompt", () => {
    const intent = parseLine(":guru");
    expect(intent).toEqual({ kind: "prompt", agent: "guru", prompt: "" });
  });

  it("rejects lines without the ':' prefix", () => {
    expect(() => parseLine("guru do the thing")).toThrowError(ShellPromptBridgeError);
  });

  it("rejects a bare ':' with no agent id", () => {
    expect(() => parseLine(":")).toThrowError(ShellPromptBridgeError);
    expect(() => parseLine(":   ")).toThrowError(ShellPromptBridgeError);
  });

  it("rejects an empty line", () => {
    expect(() => parseLine("")).toThrowError(ShellPromptBridgeError);
    expect(() => parseLine("   ")).toThrowError(ShellPromptBridgeError);
  });

  it("rejects an unknown meta-command in first position", () => {
    expect(() => parseLine("::teleport now")).toThrowError(/unknown meta-command/i);
    expect(() => parseLine(":teleport! now")).toThrowError(/unknown meta-command/i);
  });

  it("rejects ':suggest' without an agent id", () => {
    expect(() => parseLine(":suggest")).toThrowError(ShellPromptBridgeError);
    expect(() => parseLine(":suggest   ")).toThrowError(ShellPromptBridgeError);
  });
});

describe("dispatchIntent", () => {
  it("returns a structured prompt action and invokes the injected callback", async () => {
    const onPrompt = vi.fn(async () => undefined);
    const bridge = createShellPromptBridge({ onPrompt });

    const action = await bridge.dispatch(":guru summarize today");

    expect(action).toEqual({
      kind: "prompt",
      agent: "guru",
      prompt: "summarize today"
    });
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({
      kind: "prompt",
      agent: "guru",
      prompt: "summarize today"
    });
  });

  it("returns a structured suggest action whose command comes from suggestToBuffer", async () => {
    const bridge = createShellPromptBridge();

    const action = await bridge.dispatch(":suggest guru resume the parked session");

    expect(action).toEqual({
      kind: "suggest",
      agent: "guru",
      prompt: "resume the parked session",
      command: "guru resume the parked session"
    });
  });

  it("does not call onPrompt for suggest intents", async () => {
    const onPrompt = vi.fn(async () => undefined);
    const bridge = createShellPromptBridge({ onPrompt });

    await bridge.dispatch(":suggest guru resume");

    expect(onPrompt).not.toHaveBeenCalled();
  });

  it("propagates parse errors without invoking the callback", async () => {
    const onPrompt = vi.fn(async () => undefined);
    const bridge = createShellPromptBridge({ onPrompt });

    await expect(bridge.dispatch("no prefix here")).rejects.toThrowError(ShellPromptBridgeError);
    expect(onPrompt).not.toHaveBeenCalled();
  });
});

describe("suggestToBuffer", () => {
  it("returns the trimmed line as the shell command string", () => {
    expect(suggestToBuffer("guru resume the parked session")).toBe(
      "guru resume the parked session"
    );
  });

  it("collapses runs of whitespace into single spaces", () => {
    expect(suggestToBuffer("  guru    resume\tnow  ")).toBe("guru resume now");
  });

  it("returns an empty string for blank input", () => {
    expect(suggestToBuffer("")).toBe("");
    expect(suggestToBuffer("   \n\t  ")).toBe("");
  });

  it("never shells out — no child_process usage and returns synchronously", () => {
    // Pure function: synchronous, string in → string out, no I/O surface.
    const result = suggestToBuffer("echo should-not-execute");
    expect(typeof result).toBe("string");
    expect(result).toBe("echo should-not-execute");
  });
});
