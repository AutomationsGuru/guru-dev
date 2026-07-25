import { describe, expect, it, beforeEach } from "vitest";
import {
  type Effort,
  setEffort,
  getEffort,
  getEffortConfig,
  getStrongModelForUltra,
  effortMap,
} from '../../src/routing/effortDial.js';

describe("effortDial", () => {
  beforeEach(() => {
    // reset to default before each test for isolation
    setEffort("medium");
  });

  it("implements enum/map for all levels", () => {
    expect(effortMap.low).toEqual({ maxTokens: 4096, thinking: false });
    expect(effortMap.medium).toEqual({ maxTokens: 8192, thinking: true });
    expect(effortMap.high).toEqual({ maxTokens: 16384, thinking: true });
    expect(effortMap.ultra).toEqual({ maxTokens: 32768, thinking: true });
  });

  it("defaults to medium and getEffort returns it", () => {
    expect(getEffort()).toBe("medium");
    expect(getEffortConfig()).toEqual({ maxTokens: 8192, thinking: true });
  });

  it("setEffort/getEffort is sticky per session (module state)", () => {
    setEffort("high");
    expect(getEffort()).toBe("high");
    expect(getEffortConfig().maxTokens).toBe(16384);
    setEffort("low");
    expect(getEffort()).toBe("low");
  });

  it("ultra composes strongModel if present in pack", () => {
    setEffort("ultra", { strongModel: "claude-opus-4" });
    expect(getEffort()).toBe("ultra");
    expect(getStrongModelForUltra()).toBe("claude-opus-4");
    // non-ultra clears it
    setEffort("medium", { strongModel: "x" });
    expect(getStrongModelForUltra()).toBeUndefined();
  });

  it("throws on invalid effort", () => {
    expect(() => setEffort("invalid" as Effort)).toThrow(/Invalid effort level/);
  });
});
