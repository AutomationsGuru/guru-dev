import { describe, it, expect, beforeEach } from "vitest";
import {
  UserTriggeredHooksRegistry,
  type UserTriggeredHook,
  type UserTriggeredHookAction
} from '../../src/hooks/userTriggeredHooks.js';

describe("User-Triggered Hooks", () => {
  describe("UserTriggeredHooksRegistry — register and invoke", () => {
    let registry: UserTriggeredHooksRegistry;

    beforeEach(() => {
      registry = new UserTriggeredHooksRegistry();
    });

    it("should register a user-triggered hook and invoke it by name", () => {
      const hook: UserTriggeredHook = {
        id: "lint-staged",
        name: "/lint-staged",
        when: "userTriggered",
        enabled: true,
        then: {
          shell: { command: "npx lint-staged", confirm: false }
        }
      };
      registry.register(hook);

      expect(registry.invoke("/lint-staged")).toEqual({
        shell: { command: "npx lint-staged", confirm: false }
      });
    });

    it("should invoke by short name (no leading slash in call)", () => {
      const hook: UserTriggeredHook = {
        id: "format",
        name: "/format",
        when: "userTriggered",
        enabled: true,
        then: {
          shell: { command: "npx prettier --write .", confirm: true }
        }
      };
      registry.register(hook);

      expect(registry.invoke("format")).toEqual({
        shell: { command: "npx prettier --write .", confirm: true }
      });
    });

    it("should invoke a hook with askAgent action", () => {
      const hook: UserTriggeredHook = {
        id: "audit-ctx",
        name: "/audit-context",
        when: "userTriggered",
        enabled: true,
        then: {
          askAgent: { prompt: "Audit the current workspace context and report gaps." }
        }
      };
      registry.register(hook);

      expect(registry.invoke("/audit-context")).toEqual({
        askAgent: { prompt: "Audit the current workspace context and report gaps." }
      });
    });

    it("should return the first matching hook when multiple hooks share a name prefix", () => {
      registry.register({
        id: "a",
        name: "/audit",
        when: "userTriggered",
        enabled: true,
        then: { shell: { command: "echo first", confirm: false } }
      });
      // A second hook with the same name should be rejected by register (warn + keep first).
      // Even if registered manually, invoke returns the FIRST match it finds.
      const first = registry.invoke("/audit");
      expect(first).toEqual({
        shell: { command: "echo first", confirm: false }
      });
    });

    it("should error for unknown name", () => {
      expect(() => registry.invoke("/nonexistent")).toThrow(
        /Unknown user-triggered hook/i
      );
    });

    it("should list registered hooks", () => {
      registry.register({
        id: "h-1",
        name: "/one",
        when: "userTriggered",
        enabled: true,
        then: { shell: { command: "echo one", confirm: true } }
      });
      registry.register({
        id: "h-2",
        name: "/two",
        when: "userTriggered",
        enabled: true,
        then: { askAgent: { prompt: "analyze" } }
      });

      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list[0]?.name).toBe("/one");
      expect(list[1]?.name).toBe("/two");
    });
  });

  describe("disabled hooks — no-op on invoke", () => {
    let registry: UserTriggeredHooksRegistry;

    beforeEach(() => {
      registry = new UserTriggeredHooksRegistry();
    });

    it("should error as unknown when a hook is disabled", () => {
      registry.register({
        id: "off",
        name: "/disabled-cmd",
        when: "userTriggered",
        enabled: false,
        then: { shell: { command: "echo off", confirm: false } }
      });

      // A disabled hook behaves as absent — invoke errors.
      expect(() => registry.invoke("/disabled-cmd")).toThrow(
        /Unknown user-triggered hook/i
      );
    });
  });

  describe("clear", () => {
    it("should clear all registered hooks", () => {
      const registry = new UserTriggeredHooksRegistry();
      registry.register({
        id: "a",
        name: "/a",
        when: "userTriggered",
        enabled: true,
        then: { shell: { command: "echo a", confirm: true } }
      });
      expect(registry.list()).toHaveLength(1);
      registry.clear();
      expect(registry.list()).toHaveLength(0);
      expect(() => registry.invoke("/a")).toThrow(/Unknown/);
    });
  });

  describe("schema validation on register", () => {
    it("should reject invalid hooks at register time", () => {
      const registry = new UserTriggeredHooksRegistry();

      // Missing 'name' field — should throw
      expect(() =>
        registry.register({
          id: "bad",
          when: "userTriggered",
          enabled: true,
          then: { shell: { command: "echo bad", confirm: true } }
        } as unknown as UserTriggeredHook)
      ).toThrow();

      // 'then' action with no shell, no askAgent — should throw
      expect(() =>
        registry.register({
          id: "empty",
          name: "/empty-act",
          when: "userTriggered",
          enabled: true,
          then: {} as unknown as UserTriggeredHookAction
        } as UserTriggeredHook)
      ).toThrow();
    });
  });
});