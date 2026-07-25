import { createCompactModeState, toggleCompactMode } from "../../src/tui/compactModeToggle.js";

describe("compact mode toggle (pure state machine)", () => {
  it("defaults to off (enabled = false)", () => {
    const state = createCompactModeState();
    expect(state.enabled).toBe(false);
  });

  it("toggles off → on", () => {
    const off = createCompactModeState();
    const on = toggleCompactMode(off);
    expect(on.enabled).toBe(true);
    // Original state is unmodified (pure).
    expect(off.enabled).toBe(false);
  });

  it("toggles on → off", () => {
    const on = { enabled: true } as const;
    const off = toggleCompactMode(on);
    expect(off.enabled).toBe(false);
    // Original state is unmodified (pure).
    expect(on.enabled).toBe(true);
  });

  it("toggles off → on → off (round-trip)", () => {
    const s0 = createCompactModeState();
    expect(s0.enabled).toBe(false);

    const s1 = toggleCompactMode(s0);
    expect(s1.enabled).toBe(true);

    const s2 = toggleCompactMode(s1);
    expect(s2.enabled).toBe(false);

    // All states are immutable and distinct.
    expect(s0).not.toBe(s1);
    expect(s1).not.toBe(s2);
  });

  it("double-toggle returns to same logical state but new object", () => {
    const s0 = createCompactModeState();
    const s1 = toggleCompactMode(s0);
    const s2 = toggleCompactMode(s1);
    expect(s2.enabled).toBe(s0.enabled);
    expect(s2).not.toBe(s0); // new object, not mutated
  });

  it("createCompactModeState returns distinct objects", () => {
    const a = createCompactModeState();
    const b = createCompactModeState();
    expect(a).not.toBe(b);
    expect(a.enabled).toBe(b.enabled);
  });
});
