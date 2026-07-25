import { resolveProfile, HOOK_PROFILES } from "../../src/runtime/hookRuntimeProfilePick.js";

describe("hookRuntimeProfilePick.resolveProfile", () => {
  it("picks the minimal profile set as-is", () => {
    expect(resolveProfile(HOOK_PROFILES, "minimal")).toEqual([
      "session-start",
      "session-end"
    ]);
  });

  it("strict includes more hooks than standard, which includes more than minimal", () => {
    const minimal = resolveProfile(HOOK_PROFILES, "minimal");
    const standard = resolveProfile(HOOK_PROFILES, "standard");
    const strict = resolveProfile(HOOK_PROFILES, "strict");

    // cumulative superset relation
    for (const id of minimal) expect(standard).toContain(id);
    for (const id of standard) expect(strict).toContain(id);

    // strictly larger at each tier
    expect(standard.length).toBeGreaterThan(minimal.length);
    expect(strict.length).toBeGreaterThan(standard.length);
  });

  it("disabled ids never appear in the picked set", () => {
    const disabled = ["tool-execute", "turn-start"];
    const picked = resolveProfile(HOOK_PROFILES, "strict", disabled);

    for (const id of disabled) expect(picked).not.toContain(id);
    // non-disabled strict hooks still fire
    expect(picked).toContain("session-start");
    expect(picked).toContain("resource-loaded");
  });

  it("disabled ids that do not exist are ignored", () => {
    const picked = resolveProfile(HOOK_PROFILES, "minimal", ["no-such-hook"]);
    expect(picked).toEqual(HOOK_PROFILES.minimal);
  });

  it("does not mutate the caller's profile table", () => {
    const snapshot = JSON.parse(JSON.stringify(HOOK_PROFILES));
    const picked = resolveProfile(HOOK_PROFILES, "strict", ["session-end"]);
    picked.push("mutated-by-caller");

    expect(HOOK_PROFILES).toEqual(snapshot);
    expect(resolveProfile(HOOK_PROFILES, "strict")).toContain("session-end");
  });

  it("returns the full enabled set when disabled is omitted", () => {
    expect(resolveProfile(HOOK_PROFILES, "standard")).toEqual(HOOK_PROFILES.standard);
  });
});
