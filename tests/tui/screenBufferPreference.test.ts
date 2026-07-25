import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCREEN_BUFFER_MODE,
  SCREEN_BUFFER_MODES,
  isScreenBufferMode,
  resolveScreenBufferPreference,
  type ScreenBufferMode
} from '../../src/tui/screenBufferPreference.js';

/**
 * IDEA-F377-ALTSCREEN-01 — TUI screen-buffer preference resolver.
 *
 * Contract: a durable config-file preference chooses `inline` vs `altScreen`,
 * and a one-shot CLI flag overrides the file. The resolver is pure (no I/O, no
 * terminal escapes), invalid tokens never block boot, and the default is the
 * non-destructive `inline` mode.
 */
describe("resolveScreenBufferPreference", () => {
  describe("precedence — CLI override wins over file preference", () => {
    it("returns the CLI flag when it conflicts with the config preference (inline over altScreen)", () => {
      const result = resolveScreenBufferPreference({ cliFlag: "inline", pref: "altScreen" });
      expect(result).toEqual({ mode: "inline", source: "cli", invalidInput: [] });
    });

    it("returns the CLI flag when it conflicts with the config preference (altScreen over inline)", () => {
      const result = resolveScreenBufferPreference({ cliFlag: "altScreen", pref: "inline" });
      expect(result).toEqual({ mode: "altScreen", source: "cli", invalidInput: [] });
    });

    it("honors the CLI flag even when the config preference matches it", () => {
      const result = resolveScreenBufferPreference({ cliFlag: "altScreen", pref: "altScreen" });
      expect(result.source).toBe("cli");
      expect(result.mode).toBe("altScreen");
    });
  });

  describe("file preference applies when no CLI flag is present", () => {
    it("returns the config preference for altScreen", () => {
      expect(resolveScreenBufferPreference({ pref: "altScreen" })).toEqual({
        mode: "altScreen",
        source: "pref",
        invalidInput: []
      });
    });

    it("returns the config preference for inline", () => {
      expect(resolveScreenBufferPreference({ pref: "inline" })).toEqual({
        mode: "inline",
        source: "pref",
        invalidInput: []
      });
    });
  });

  describe("default applies when neither input is present or valid", () => {
    it("returns the non-destructive default for empty input", () => {
      expect(resolveScreenBufferPreference({})).toEqual({
        mode: DEFAULT_SCREEN_BUFFER_MODE,
        source: "default",
        invalidInput: []
      });
    });

    it("returns the default when both inputs are absent (no args)", () => {
      expect(resolveScreenBufferPreference()).toEqual({
        mode: DEFAULT_SCREEN_BUFFER_MODE,
        source: "default",
        invalidInput: []
      });
    });

    it("defaults to inline", () => {
      expect(DEFAULT_SCREEN_BUFFER_MODE).toBe("inline");
      expect(resolveScreenBufferPreference({}).mode).toBe("inline");
    });
  });

  describe("invalid tokens never block boot — fall through to next precedence", () => {
    it("ignores an invalid CLI flag and falls back to a valid config preference", () => {
      const result = resolveScreenBufferPreference({ cliFlag: "fullscreen", pref: "altScreen" });
      expect(result.mode).toBe("altScreen");
      expect(result.source).toBe("pref");
      expect(result.invalidInput).toEqual(["fullscreen"]);
    });

    it("ignores both invalid CLI and invalid config, falling back to default", () => {
      const result = resolveScreenBufferPreference({ cliFlag: "alt", pref: "alt" });
      expect(result.mode).toBe(DEFAULT_SCREEN_BUFFER_MODE);
      expect(result.source).toBe("default");
      expect(result.invalidInput).toEqual(["alt", "alt"]);
    });

    it("treats null/undefined inputs as absent (not invalid)", () => {
      expect(resolveScreenBufferPreference({ cliFlag: null, pref: null })).toEqual({
        mode: DEFAULT_SCREEN_BUFFER_MODE,
        source: "default",
        invalidInput: []
      });
      expect(resolveScreenBufferPreference({ cliFlag: undefined, pref: undefined })).toEqual({
        mode: DEFAULT_SCREEN_BUFFER_MODE,
        source: "default",
        invalidInput: []
      });
    });

    it("a valid CLI flag overrides an invalid config preference without surfacing it", () => {
      const result = resolveScreenBufferPreference({ cliFlag: "inline", pref: "fullscreen" });
      expect(result).toEqual({ mode: "inline", source: "cli", invalidInput: [] });
    });
  });

  describe("isScreenBufferMode / SCREEN_BUFFER_MODES", () => {
    it("recognizes exactly the two valid tokens", () => {
      expect(SCREEN_BUFFER_MODES).toEqual(["inline", "altScreen"]);
    });

    it.each(["inline", "altScreen"] as const)("isScreenBufferMode(%s) is true", (mode: ScreenBufferMode) => {
      expect(isScreenBufferMode(mode)).toBe(true);
    });

    it.each(["alt", "fullscreen", "", "AltScreen", "INLINE", 42, null, undefined])(
      "isScreenBufferMode(%p) is false",
      (bad: unknown) => {
        expect(isScreenBufferMode(bad)).toBe(false);
      }
    );
  });
});
