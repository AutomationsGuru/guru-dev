import {
  createConnectProviderWizard,
  startSelecting,
  markConfigured,
  type ConnectProviderWizardState
} from '../../src/config/connectProviderWizardState.js';

describe("ConnectProviderWizardState", () => {
  describe("initial state (idle)", () => {
    it("starts in idle with empty provider sets", () => {
      const state = createConnectProviderWizard();

      expect(state.phase).toBe("idle");
      expect(state.pending.size).toBe(0);
      expect(state.configured.size).toBe(0);
    });
  });

  describe("startSelecting", () => {
    it("transitions idle → selecting with the supplied provider IDs", () => {
      const idle = createConnectProviderWizard();
      const state = startSelecting(idle, ["openai", "anthropic", "azure"]);

      expect(state.phase).toBe("selecting");
      expect([...state.pending].sort()).toEqual(["anthropic", "azure", "openai"]);
      expect(state.configured.size).toBe(0);
    });

    it("leaves the original state unchanged (immutable)", () => {
      const idle = createConnectProviderWizard();
      startSelecting(idle, ["openai"]);

      expect(idle.phase).toBe("idle");
      expect(idle.pending.size).toBe(0);
    });

    it("is a no-op when already in selecting phase", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai", "anthropic"]);
      const retry = startSelecting(selecting, ["gemini"]);

      // Should preserve the original provider list, not replace it.
      expect(retry.phase).toBe("selecting");
      expect([...retry.pending].sort()).toEqual(["anthropic", "openai"]);
    });

    it("is a no-op when already in done phase", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai"]);
      const configured = markConfigured(selecting, "openai"); // auto-done when empty
      const retry = startSelecting(configured, ["azure"]);

      expect(retry.phase).toBe("done");
      expect(retry.pending.size).toBe(0);
    });

    it("accepts an empty provider list", () => {
      const idle = createConnectProviderWizard();
      const state = startSelecting(idle, []);

      expect(state.phase).toBe("selecting");
      expect(state.pending.size).toBe(0);
    });
  });

  describe("markConfigured", () => {
    it("moves a pending provider to configured", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai", "anthropic"]);
      const state = markConfigured(selecting, "openai");

      expect(state.phase).toBe("selecting");
      expect([...state.pending]).toEqual(["anthropic"]);
      expect([...state.configured]).toEqual(["openai"]);
    });

    it("auto-transitions to done when the last provider is configured", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai"]);
      const state = markConfigured(selecting, "openai");

      expect(state.phase).toBe("done");
      expect(state.pending.size).toBe(0);
      expect([...state.configured]).toEqual(["openai"]);
    });

    it("leaves the original state unchanged (immutable)", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai", "anthropic"]);
      markConfigured(selecting, "openai");

      expect([...selecting.pending].sort()).toEqual(["anthropic", "openai"]);
      expect(selecting.configured.size).toBe(0);
    });

    it("is a no-op from idle phase", () => {
      const idle = createConnectProviderWizard();
      const state = markConfigured(idle, "openai");

      expect(state.phase).toBe("idle");
      expect(state.pending.size).toBe(0);
      expect(state.configured.size).toBe(0);
    });

    it("is a no-op from done phase", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai"]);
      const done = markConfigured(selecting, "openai");
      const state = markConfigured(done, "anthropic");

      expect(state.phase).toBe("done");
      expect(state.configured.size).toBe(1);
      expect([...state.configured]).toEqual(["openai"]);
      expect(state.pending.size).toBe(0);
    });

    it("is a no-op when the provider is not in the pending set", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai"]);
      const state = markConfigured(selecting, "anthropic");

      expect(state.phase).toBe("selecting");
      expect([...state.pending]).toEqual(["openai"]);
      expect(state.configured.size).toBe(0);
    });

    it("is a no-op when provider is already configured", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai", "anthropic"]);
      const afterFirst = markConfigured(selecting, "openai");
      const afterSecond = markConfigured(afterFirst, "openai");

      expect(afterSecond.phase).toBe("selecting");
      expect([...afterSecond.pending]).toEqual(["anthropic"]);
      expect([...afterSecond.configured]).toEqual(["openai"]);
    });

    it("supports configuring multiple providers incrementally", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai", "anthropic", "azure"]);
      const s1 = markConfigured(selecting, "openai");
      const s2 = markConfigured(s1, "azure");

      expect(s2.phase).toBe("selecting");
      expect([...s2.pending]).toEqual(["anthropic"]);
      expect([...s2.configured].sort()).toEqual(["azure", "openai"]);

      const s3 = markConfigured(s2, "anthropic");
      expect(s3.phase).toBe("done");
      expect(s3.pending.size).toBe(0);
      expect([...s3.configured].sort()).toEqual(["anthropic", "azure", "openai"]);
    });
  });

  describe("state shape (no secrets)", () => {
    it("has no fields that could hold secret values", () => {
      const idle = createConnectProviderWizard();
      const selecting = startSelecting(idle, ["openai", "anthropic"]);
      const done = markConfigured(markConfigured(selecting, "openai"), "anthropic");

      for (const state of [idle, selecting, done]) {
        // Only phase, pending, and configured are allowed — no secret-key-bearing fields.
        const keys = Object.keys(state);
        expect(keys.sort()).toEqual(["configured", "pending", "phase"]);

        // No string fields that could be confused with an API key.
        for (const key of keys) {
          const val = (state as unknown as Record<string, unknown>)[key];
          if (typeof val === "string") {
            // The only string field is 'phase', which must be one of the three known values.
            expect(key).toBe("phase");
            expect(["idle", "selecting", "done"]).toContain(val);
          }
          if (val instanceof Set) {
            for (const item of val) {
              expect(typeof item).toBe("string");
              // Provider IDs are identifiers, never long secret strings.
              expect(item.length).toBeLessThan(200);
            }
          }
        }
      }
    });
  });
});
