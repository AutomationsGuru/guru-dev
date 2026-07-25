import { describe, it, expect, beforeEach } from "vitest";
import {
  AgentEventHooksRegistry,
  isHardLimitTool,
  replacePlaceholders,
  matchHooks,
  runHandlers,
  HARD_LIMIT_TOOLS
} from '../../src/hooks/agentEventHooks.js';
import type { HookEvent, AgentEventHook } from '../../src/hooks/agentEventHooksSchema.js';

describe("Agent Event Hooks", () => {
  describe("replacePlaceholders", () => {
    it("should replace {{path}} placeholder", () => {
      const template = "Running on {{path}}";
      const event: HookEvent = { type: "fileSaved", path: "src/index.ts" };
      expect(replacePlaceholders(template, event)).toBe("Running on src/index.ts");
    });

    it("should replace {{prompt}} placeholder", () => {
      const template = "Prompt was: {{prompt}}";
      const event: HookEvent = { type: "promptSubmit", prompt: "Hello agent" };
      expect(replacePlaceholders(template, event)).toBe("Prompt was: Hello agent");
    });

    it("should replace {{tool}} placeholder", () => {
      const template = "Executing {{tool}}";
      const event: HookEvent = { type: "preTool", tool: "bash" };
      expect(replacePlaceholders(template, event)).toBe("Executing bash");
    });

    it("should replace {{taskId}} and {{subject}} placeholders", () => {
      const template = "Task [{{taskId}}] is: {{subject}}";
      const event: HookEvent = { type: "taskStart", taskId: "T123", subject: "Refactoring" };
      expect(replacePlaceholders(template, event)).toBe("Task [T123] is: Refactoring");
    });

    it("should ignore missing placeholders", () => {
      const template = "Running on {{path}} and {{prompt}}";
      const event: HookEvent = { type: "fileSaved", path: "src/index.ts" };
      expect(replacePlaceholders(template, event)).toBe("Running on src/index.ts and {{prompt}}");
    });
  });

  describe("isHardLimitTool", () => {
    it("should identify hard-limit tools correctly", () => {
      expect(isHardLimitTool("bash")).toBe(true);
      expect(isHardLimitTool("write")).toBe(true);
      expect(isHardLimitTool("edit")).toBe(true);
      expect(isHardLimitTool("shellExec")).toBe(true);
      expect(isHardLimitTool("someOtherTool")).toBe(false);
    });

    it("should cover all listed hard-limit tools in HARD_LIMIT_TOOLS set", () => {
      for (const tool of HARD_LIMIT_TOOLS) {
        expect(isHardLimitTool(tool)).toBe(true);
      }
    });
  });

  describe("matchHooks and runHandlers", () => {
    const testHooks: AgentEventHook[] = [
      {
        id: "hook-file-saved",
        when: "fileSaved",
        pattern: "\\.ts$",
        enabled: true,
        then: {
          shell: { command: "npm run lint {{path}}", confirm: false }
        }
      },
      {
        id: "hook-disabled",
        when: "fileSaved",
        pattern: "\\.ts$",
        enabled: false,
        then: {
          shell: { command: "echo disabled", confirm: true }
        }
      },
      {
        id: "hook-prompt-submit",
        when: "promptSubmit",
        pattern: "^lint",
        enabled: true,
        then: {
          askAgent: { prompt: "Analyze lint rule: {{prompt}}" }
        }
      },
      {
        id: "hook-pre-tool-bash",
        when: "preTool",
        pattern: "^bash$",
        enabled: true,
        then: {
          skip: true
        }
      },
      {
        id: "hook-pre-tool-other",
        when: "preTool",
        pattern: "^someOtherTool$",
        enabled: true,
        then: {
          skip: true
        }
      },
      {
        id: "hook-task-start",
        when: "taskStart",
        enabled: true,
        then: {
          shell: { command: "echo starting task {{taskId}}", confirm: true }
        }
      }
    ];

    it("should match hooks by event type and pattern", () => {
      const event: HookEvent = { type: "fileSaved", path: "src/index.ts" };
      const matched = matchHooks(testHooks, event);
      expect(matched).toHaveLength(1);
      expect(matched[0]?.id).toBe("hook-file-saved");
    });

    it("should not match disabled hooks", () => {
      const event: HookEvent = { type: "fileSaved", path: "src/index.ts" };
      const matched = matchHooks(testHooks, event);
      expect(matched.some(h => h.id === "hook-disabled")).toBe(false);
    });

    it("should replace placeholders in runHandlers output", () => {
      const event: HookEvent = { type: "fileSaved", path: "src/index.ts" };
      const actions = runHandlers(testHooks, event);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.shell?.command).toBe("npm run lint src/index.ts");
      expect(actions[0]?.shell?.confirm).toBe(false);
    });

    it("should handle askAgent payload and replace placeholders", () => {
      const event: HookEvent = { type: "promptSubmit", prompt: "lint my file" };
      const actions = runHandlers(testHooks, event);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.askAgent?.prompt).toBe("Analyze lint rule: lint my file");
    });

    it("should return empty array when no hooks match", () => {
      const event: HookEvent = { type: "fileSaved", path: "src/index.js" }; // doesn't match .ts$ pattern
      const actions = runHandlers(testHooks, event);
      expect(actions).toHaveLength(0);
    });

    it("should respect hard-limit tools rule: never auto-skipped by hooks", () => {
      // For a hard-limit tool "bash", a hook that specifies "skip: true" should have the skip flag removed,
      // and because no other action is specified, it returns nothing/skips the action entirely or ignores skip.
      const bashEvent: HookEvent = { type: "preTool", tool: "bash" };
      const bashActions = runHandlers(testHooks, bashEvent);
      // Wait, since 'skip' is removed and nothing else exists in hook-pre-tool-bash, it shouldn't skip, meaning no skip action is returned!
      expect(bashActions.some(a => a.skip === true)).toBe(false);

      // For a non-hard-limit tool "someOtherTool", the skip action is preserved!
      const otherEvent: HookEvent = { type: "preTool", tool: "someOtherTool" };
      const otherActions = runHandlers(testHooks, otherEvent);
      expect(otherActions).toHaveLength(1);
      expect(otherActions[0]?.skip).toBe(true);
    });
  });

  describe("AgentEventHooksRegistry", () => {
    let registry: AgentEventHooksRegistry;

    beforeEach(() => {
      registry = new AgentEventHooksRegistry();
    });

    it("should register hooks and match them", () => {
      const hook: AgentEventHook = {
        id: "my-hook",
        when: "promptSubmit",
        enabled: true,
        then: {
          shell: { command: "echo {{prompt}}", confirm: true }
        }
      };

      registry.register(hook);
      expect(registry.getHooks()).toHaveLength(1);
      expect(registry.getHooks()[0]?.id).toBe("my-hook");

      const event: HookEvent = { type: "promptSubmit", prompt: "hello" };
      const matched = registry.match(event);
      expect(matched).toHaveLength(1);
      expect(matched[0]?.id).toBe("my-hook");

      const actions = registry.runHandlers(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.shell?.command).toBe("echo hello");
    });

    it("should clear registered hooks", () => {
      registry.register({
        id: "my-hook",
        when: "promptSubmit",
        enabled: true,
        then: {
          shell: { command: "echo {{prompt}}", confirm: true }
        }
      });
      expect(registry.getHooks()).toHaveLength(1);
      registry.clear();
      expect(registry.getHooks()).toHaveLength(0);
    });
  });
});
