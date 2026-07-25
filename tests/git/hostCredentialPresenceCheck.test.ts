import { hasCredential, type HostCredentialSlotMeta } from '../../src/git/hostCredentialPresenceCheck.js';

describe("hasCredential", () => {
  it("returns true for a present host credential slot", () => {
    expect(hasCredential({ present: true })).toBe(true);
  });

  it("returns false for an absent host credential slot", () => {
    expect(hasCredential({ present: false })).toBe(false);
  });

  it("uses only presence metadata and does not log credential values", () => {
    const slotMeta: HostCredentialSlotMeta = { present: true };
    Object.defineProperty(slotMeta, "secret", {
      get(): never {
        throw new Error("Credential value must not be read.");
      }
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(hasCredential(slotMeta)).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
