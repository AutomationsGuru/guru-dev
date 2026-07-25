import {
  classifyTool,
  isAllowed,
  PLANNING_AGENT_ALLOWED_TOOL_IDS
} from '../../src/agents/planningAgentToolGate.js';

describe("planningAgentToolGate", () => {
  describe("isAllowed", () => {
    it.each(["read", "grep", "glob", "ls", "find", "lsp", "read_diagnostics"])(
      "allows read-only inspection tool: %s",
      (toolId) => {
        expect(isAllowed(toolId)).toBe(true);
      }
    );

    it.each(["write", "edit", "fs.edit.apply"])("denies filesystem write tool: %s", (toolId) => {
      expect(isAllowed(toolId)).toBe(false);
    });

    it("allows the plan-artifact board tool (todo_write)", () => {
      // The task board is the planner's own working surface — process memory
      // only, never disk — so plan drafting stays possible under the gate.
      expect(isAllowed("todo_write")).toBe(true);
      expect(isAllowed("todo_list")).toBe(true);
    });

    it.each(["bash", "shell.command.run"])("denies shell-exec tool: %s", (toolId) => {
      expect(isAllowed(toolId)).toBe(false);
    });

    it.each(["web_fetch", "web_search"])("allows bounded web research tool: %s", (toolId) => {
      expect(isAllowed(toolId)).toBe(true);
    });

    it.each(["memory_remember", "memory_forget", "memory_doctor", "honcho_remember", "honcho_log_turn"])(
      "denies memory write tool: %s",
      (toolId) => {
        expect(isAllowed(toolId)).toBe(false);
      }
    );

    it.each(["memory_search", "memory_get", "memory_status", "honcho_recall", "honcho_context"])(
      "allows memory read tool: %s",
      (toolId) => {
        expect(isAllowed(toolId)).toBe(true);
      }
    );

    it.each(["spawn_agent", "kill_task"])(
      "denies spawn/lifecycle tool (a spawned worker could mutate): %s",
      (toolId) => {
        expect(isAllowed(toolId)).toBe(false);
      }
    );

    it.each([
      "operational.state.write",
      "operational.decision.upsert",
      "operational.backlog.create",
      "operational.implementation.create",
      "operational.blocker.record"
    ])("denies operational write tool: %s", (toolId) => {
      expect(isAllowed(toolId)).toBe(false);
    });

    it.each(["operational.project.get", "operational.state.list", "operational.backlog.list"])(
      "allows operational read tool: %s",
      (toolId) => {
        expect(isAllowed(toolId)).toBe(true);
      }
    );

    it.each(["provider_cli_run", "pyautogui_mouse", "pyautogui_keyboard", "use_tool", "review.gates.run"])(
      "denies delegated-exec / actuation tool: %s",
      (toolId) => {
        expect(isAllowed(toolId)).toBe(false);
      }
    );

    it("denies an unknown tool id (fail-closed)", () => {
      expect(isAllowed("not_a_real_tool")).toBe(false);
      expect(isAllowed("")).toBe(false);
    });

    it("is case-sensitive and does not trim (exact id match only)", () => {
      expect(isAllowed("Read")).toBe(false);
      expect(isAllowed(" read")).toBe(false);
    });
  });

  describe("classifyTool", () => {
    it("classifies allowlisted tools as allow", () => {
      expect(classifyTool("read")).toBe("allow");
      expect(classifyTool("todo_write")).toBe("allow");
      expect(classifyTool("web_search")).toBe("allow");
    });

    it("classifies known write/shell-risk tools as deny-write-shell", () => {
      expect(classifyTool("write")).toBe("deny-write-shell");
      expect(classifyTool("bash")).toBe("deny-write-shell");
      expect(classifyTool("shell.command.run")).toBe("deny-write-shell");
      expect(classifyTool("spawn_agent")).toBe("deny-write-shell");
      expect(classifyTool("memory_remember")).toBe("deny-write-shell");
      expect(classifyTool("operational.state.write")).toBe("deny-write-shell");
    });

    it("classifies unrecognized ids as deny-unknown", () => {
      expect(classifyTool("definitely_not_registered")).toBe("deny-unknown");
      expect(classifyTool("")).toBe("deny-unknown");
    });

    it("agrees with isAllowed on every classified id", () => {
      const samples = [
        "read",
        "write",
        "bash",
        "todo_write",
        "spawn_agent",
        "web_fetch",
        "memory_remember",
        "unknown_tool_xyz"
      ];
      for (const toolId of samples) {
        expect(isAllowed(toolId)).toBe(classifyTool(toolId) === "allow");
      }
    });
  });

  describe("PLANNING_AGENT_ALLOWED_TOOL_IDS", () => {
    it("contains the core inspection and plan-artifact ids", () => {
      for (const toolId of ["read", "grep", "glob", "ls", "todo_write", "todo_list", "web_fetch"]) {
        expect(PLANNING_AGENT_ALLOWED_TOOL_IDS.has(toolId)).toBe(true);
      }
    });

    it("does not contain write or shell ids", () => {
      for (const toolId of ["write", "edit", "bash", "shell.command.run", "spawn_agent"]) {
        expect(PLANNING_AGENT_ALLOWED_TOOL_IDS.has(toolId)).toBe(false);
      }
    });

    it("is immutable against runtime enlargement (mutation methods throw)", () => {
      // Object.freeze alone cannot seal a Set's internal slots, so the export
      // is an immutable facade: add/delete/clear and property writes throw
      // TypeError, and the gate can never be enlarged at runtime.
      const mutable = PLANNING_AGENT_ALLOWED_TOOL_IDS as Set<string>;
      expect(() => mutable.add("bash")).toThrow(TypeError);
      expect(() => mutable.delete("read")).toThrow(TypeError);
      expect(() => mutable.clear()).toThrow(TypeError);
      expect(() => {
        (PLANNING_AGENT_ALLOWED_TOOL_IDS as unknown as Record<string, unknown>).extra = true;
      }).toThrow(TypeError);
      expect(PLANNING_AGENT_ALLOWED_TOOL_IDS.has("bash")).toBe(false);
      expect(PLANNING_AGENT_ALLOWED_TOOL_IDS.has("read")).toBe(true);
    });

    it("still behaves as a read-only Set (has/size/iteration)", () => {
      expect(typeof PLANNING_AGENT_ALLOWED_TOOL_IDS.size).toBe("number");
      expect(PLANNING_AGENT_ALLOWED_TOOL_IDS.size).toBeGreaterThan(0);
      const ids = [...PLANNING_AGENT_ALLOWED_TOOL_IDS];
      expect(ids).toContain("read");
      expect(ids.every((id) => typeof id === "string")).toBe(true);
    });
  });
});
