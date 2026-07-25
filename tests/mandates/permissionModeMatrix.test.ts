import { describe, expect, it } from "vitest";
import { mayAuto } from '../../src/mandates/permissionModeMatrix.js';

describe("permissionModeMatrix", () => {
  describe("strict", () => {
    it("denies auto-approve for all tool classes", () => {
      expect(mayAuto("strict", "read")).toBe(false);
      expect(mayAuto("strict", "write")).toBe(false);
      expect(mayAuto("strict", "exec")).toBe(false);
      expect(mayAuto("strict", "hard-limit")).toBe(false);
    });
  });

  describe("permissive", () => {
    it("auto-approves safe classes (read) but denies mutating ones", () => {
      expect(mayAuto("permissive", "read")).toBe(true);
      expect(mayAuto("permissive", "write")).toBe(false);
      expect(mayAuto("permissive", "exec")).toBe(false);
    });
  });

  describe("hard-limit", () => {
    it("tools always deny-auto in every mode", () => {
      expect(mayAuto("strict", "hard-limit")).toBe(false);
      expect(mayAuto("permissive", "hard-limit")).toBe(false);
      expect(mayAuto("yolo", "hard-limit")).toBe(false);
    });
  });

  describe("yolo", () => {
    it("auto-approves non-hard-limit tools", () => {
      expect(mayAuto("yolo", "read")).toBe(true);
      expect(mayAuto("yolo", "write")).toBe(true);
      expect(mayAuto("yolo", "exec")).toBe(true);
    });
  });
});
