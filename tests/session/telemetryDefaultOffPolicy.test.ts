import { describe, expect, it } from "vitest";

import {
  DEFAULT_TELEMETRY_SHARING_CONFIG,
  TelemetrySharingConfigSchema,
  mayShare
} from '../../src/session/telemetryDefaultOffPolicy.js';

describe("telemetryDefaultOffPolicy — default-off, fail-closed", () => {
  describe("mayShare defaults to false", () => {
    it("returns false with no argument", () => {
      expect(mayShare()).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(mayShare(undefined)).toBe(false);
    });

    it("returns false for null", () => {
      expect(mayShare(null)).toBe(false);
    });

    it("returns false for an empty object (schema defaults apply)", () => {
      expect(mayShare({})).toBe(false);
    });
  });

  describe("explicit opt-in requires BOTH gates", () => {
    it("returns true only when enabled AND shareCrew are both true", () => {
      expect(mayShare({ enabled: true, shareCrew: true })).toBe(true);
    });

    it("returns false when shareCrew is true but telemetry is not enabled", () => {
      expect(mayShare({ enabled: false, shareCrew: true })).toBe(false);
    });

    it("returns false when enabled is true but shareCrew is not opted in", () => {
      expect(mayShare({ enabled: true, shareCrew: false })).toBe(false);
    });

    it("returns false when shareCrew gate is absent (default false) even if enabled", () => {
      expect(mayShare({ enabled: true })).toBe(false);
    });
  });

  describe("explicit false stays false", () => {
    it("returns false when both gates are explicitly false", () => {
      expect(mayShare({ enabled: false, shareCrew: false })).toBe(false);
    });
  });

  describe("malformed input fails closed without throwing", () => {
    it("returns false for wrong-typed fields", () => {
      expect(mayShare({ enabled: "yes", shareCrew: 1 })).toBe(false);
    });

    it("returns false for truthy-but-non-boolean values", () => {
      expect(mayShare({ enabled: "true", shareCrew: "true" })).toBe(false);
    });

    it("returns false for garbage primitives and never throws", () => {
      expect(() => mayShare(42)).not.toThrow();
      expect(mayShare(42)).toBe(false);
      expect(mayShare("share_crew")).toBe(false);
      expect(mayShare(true)).toBe(false);
      expect(mayShare([])).toBe(false);
      expect(mayShare(Symbol("x"))).toBe(false);
    });

    it("returns false for unknown/extra keys (strict schema rejects them)", () => {
      expect(mayShare({ enabled: true, shareCrew: true, extra: true })).toBe(false);
      expect(mayShare({ shareCrewX: true })).toBe(false);
    });

    it("returns false (never throws) for an object whose getter throws", () => {
      const hostile = {
        get enabled(): boolean {
          throw new Error("boom");
        },
        shareCrew: true
      };
      expect(() => mayShare(hostile)).not.toThrow();
      expect(mayShare(hostile)).toBe(false);
    });
  });

  describe("schema and defaults", () => {
    it("DEFAULT_TELEMETRY_SHARING_CONFIG has both gates off", () => {
      expect(DEFAULT_TELEMETRY_SHARING_CONFIG.enabled).toBe(false);
      expect(DEFAULT_TELEMETRY_SHARING_CONFIG.shareCrew).toBe(false);
    });

    it("the default config shares nothing", () => {
      expect(mayShare(DEFAULT_TELEMETRY_SHARING_CONFIG)).toBe(false);
    });

    it("strict() rejects unknown keys at parse time", () => {
      const result = TelemetrySharingConfigSchema.safeParse({
        enabled: true,
        shareCrew: true,
        rogue: true
      });
      expect(result.success).toBe(false);
    });

    it("parsing an empty object yields the safe defaults", () => {
      const parsed = TelemetrySharingConfigSchema.parse({});
      expect(parsed).toEqual({ enabled: false, shareCrew: false });
    });
  });
});
