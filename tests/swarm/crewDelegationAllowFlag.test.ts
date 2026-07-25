import { describe, expect, it } from "vitest";

import { mayDelegate, type DelegatingAgent } from "../../src/swarm/crewDelegationAllowFlag.js";

/**
 * IDEA-F560-DELEG-01 (R-CR-DELEG): the crew delegation allow flag is a pure
 * deny-only gate. A caller-supplied agent may delegate only when its
 * `mayDelegate` is exactly `true`; false or absent must fail closed. These
 * tests pin the fail-closed behavior across explicit true, explicit false,
 * missing, and non-boolean values (no coercion), and assert the helper stays a
 * side-effect-free boolean with no authority of its own.
 */
describe("crew delegation allow flag (IDEA-F560-DELEG-01) — deny-only predicate", () => {
  it("permits delegation only for an explicit boolean `mayDelegate: true`", () => {
    expect(mayDelegate({ mayDelegate: true })).toBe(true);
  });

  it("explicit `mayDelegate: false` blocks delegation (fail closed)", () => {
    expect(mayDelegate({ mayDelegate: false })).toBe(false);
  });

  it("absent `mayDelegate` blocks delegation (fail closed)", () => {
    // The common case: an ordinary agent that never opted into delegation.
    const agent: DelegatingAgent = {};
    expect(mayDelegate(agent)).toBe(false);
  });

  it("never coerces a truthy non-boolean value into a yes (no silent authority grant)", () => {
    // A stray string, number, or object must NOT count as authorization.
    expect(mayDelegate({ mayDelegate: "yes" as unknown })).toBe(false);
    expect(mayDelegate({ mayDelegate: 1 as unknown })).toBe(false);
    expect(mayDelegate({ mayDelegate: "true" as unknown })).toBe(false);
    expect(mayDelegate({ mayDelegate: { allowed: true } as unknown })).toBe(false);
  });

  it("rejects nullish / malformed agent input without throwing", () => {
    // The gate must remain a safe boolean even when handed garbage; it never
    // elevates a malformed input to "may delegate".
    expect(mayDelegate(null as unknown as DelegatingAgent)).toBe(false);
    expect(mayDelegate(undefined as unknown as DelegatingAgent)).toBe(false);
  });

  it("is pure: calling it repeatedly with the same agent is stable and side-effect free", () => {
    const agent: DelegatingAgent = { mayDelegate: false };
    expect(mayDelegate(agent)).toBe(false);
    expect(mayDelegate(agent)).toBe(false);
    // The input is untouched — the gate does not mutate or confer authority.
    expect(agent).toEqual({ mayDelegate: false });
  });

  it("cannot grant authority it was not given: true out requires true in", () => {
    // Directly state the plan invariant — the only path to `true` is the caller
    // already setting `mayDelegate` to the literal boolean true.
    for (const value of [undefined, false, null, "true", 1, {}, []]) {
      expect(mayDelegate({ mayDelegate: value as unknown })).toBe(false);
    }
    expect(mayDelegate({ mayDelegate: true })).toBe(true);
  });
});
