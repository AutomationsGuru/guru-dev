import { describe, expect, it } from "vitest";

import {
  ASK_POSTURE_READ_ONLY_TOOLS,
  enterAskPosture,
  evaluateAskPostureGate,
  exitAskPosture,
  isAskPostureAllowedTool
} from '../../src/mandates/askPosture.js';

function makeSession(askMode = false) {
  return { askMode };
}

function fixedNow() {
  return new Date("2026-07-18T22:03:00.000Z");
}

describe("askPosture — opt-in read-only scout mode", () => {
  describe("mode transitions", () => {
    it("enterAskPosture sets the flag and returns an enter receipt", () => {
      const session = makeSession(false);
      const receipt = enterAskPosture(session, fixedNow);
      expect(session.askMode).toBe(true);
      expect(receipt.kind).toBe("enter");
      expect(receipt.at).toBe("2026-07-18T22:03:00.000Z");
      expect(receipt.message).toContain("entered ask posture");
    });

    it("enterAskPosture while already active notes the no-op and keeps the flag", () => {
      const session = makeSession(true);
      const receipt = enterAskPosture(session, fixedNow);
      expect(session.askMode).toBe(true);
      expect(receipt.kind).toBe("enter");
      expect(receipt.message).toContain("already active");
    });

    it("exitAskPosture clears the flag and returns an exit receipt", () => {
      const session = makeSession(true);
      const receipt = exitAskPosture(session, fixedNow);
      expect(session.askMode).toBe(false);
      expect(receipt.kind).toBe("exit");
      expect(receipt.at).toBe("2026-07-18T22:03:00.000Z");
      expect(receipt.message).toContain("exited ask posture");
    });

    it("exitAskPosture while already inactive is a no-op", () => {
      const session = makeSession(false);
      const receipt = exitAskPosture(session, fixedNow);
      expect(session.askMode).toBe(false);
      expect(receipt.kind).toBe("exit");
      expect(receipt.message).toContain("already inactive");
    });
  });

  describe("tool classification", () => {
    it("read-only tools are allowed", () => {
      for (const toolId of ASK_POSTURE_READ_ONLY_TOOLS) {
        expect(isAskPostureAllowedTool(toolId), toolId).toBe(true);
      }
    });

    it("additional inspection tools are allowed", () => {
      expect(isAskPostureAllowedTool("get_task_output")).toBe(true);
      expect(isAskPostureAllowedTool("resolve_capability_gap")).toBe(true);
      expect(isAskPostureAllowedTool("pyautogui_screen")).toBe(true);
    });

    it("mutating tools are not allowed", () => {
      expect(isAskPostureAllowedTool("write")).toBe(false);
      expect(isAskPostureAllowedTool("edit")).toBe(false);
      expect(isAskPostureAllowedTool("bash")).toBe(false);
      expect(isAskPostureAllowedTool("shell.command.run")).toBe(false);
      expect(isAskPostureAllowedTool("web_fetch")).toBe(false);
      expect(isAskPostureAllowedTool("web_search")).toBe(false);
      expect(isAskPostureAllowedTool("memory_remember")).toBe(false);
      expect(isAskPostureAllowedTool("memory_forget")).toBe(false);
      expect(isAskPostureAllowedTool("spawn_agent")).toBe(false);
      expect(isAskPostureAllowedTool("kill_task")).toBe(false);
      expect(isAskPostureAllowedTool("use_tool")).toBe(false);
    });
  });

  describe("evaluateAskPostureGate", () => {
    it("when askMode is off, every tool passes the gate", () => {
      const session = makeSession(false);
      expect(evaluateAskPostureGate("write", session).denied).toBe(false);
      expect(evaluateAskPostureGate("bash", session).denied).toBe(false);
      expect(evaluateAskPostureGate("read", session).denied).toBe(false);
      expect(evaluateAskPostureGate("web_fetch", session).denied).toBe(false);
    });

    it("when askMode is on, read-only tools pass the gate", () => {
      const session = makeSession(true);
      for (const toolId of ASK_POSTURE_READ_ONLY_TOOLS) {
        const result = evaluateAskPostureGate(toolId, session);
        expect(result.denied, toolId).toBe(false);
        expect(result.reason, toolId).toBe("");
      }
    });

    it("when askMode is on, mutating tools are denied with a clear reason", () => {
      const session = makeSession(true);
      for (const toolId of [
        "write",
        "edit",
        "bash",
        "shell.command.run",
        "web_fetch",
        "web_search",
        "memory_remember",
        "spawn_agent",
        "kill_task",
        "use_tool"
      ]) {
        const result = evaluateAskPostureGate(toolId, session);
        expect(result.denied, toolId).toBe(true);
        expect(result.reason, toolId).toContain("ask posture active");
        expect(result.reason, toolId).toContain(toolId);
      }
    });

    it("exiting the mode restores ordinary tool permission", () => {
      const session = makeSession(true);
      expect(evaluateAskPostureGate("write", session).denied).toBe(true);
      exitAskPosture(session, fixedNow);
      expect(evaluateAskPostureGate("write", session).denied).toBe(false);
      expect(evaluateAskPostureGate("bash", session).denied).toBe(false);
      expect(evaluateAskPostureGate("read", session).denied).toBe(false);
    });
  });
});
