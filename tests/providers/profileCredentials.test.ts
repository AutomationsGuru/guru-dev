import { describe, expect, it } from "vitest";

import {
  ProfileCredentialStoreSchema,
  ProviderProfileSchema,
  createProfileCredentialStore,
  resolveActiveCredentials,
  type ProfileCredentialLookup,
  type ProviderProfile
} from '../../src/providers/profileCredentials.js';

/**
 * R-OH-PROF-CRED (F317): two OpenAI-compatible profiles may hold distinct API
 * keys; activating profile B must never send profile A's key. Tests use a fake
 * lookup; no real secret value is ever read, printed, or persisted. We assert
 * against fixed sentinel markers that stand in for secret material — the real
 * resolver only ever returns an opaque secret handle, never the value itself.
 */

const SENTINEL_A = "key-handle-A";
const SENTINEL_B = "key-handle-B";

function fakeLookup(initial: Record<string, string>): ProfileCredentialLookup {
  const table = new Map<string, string>(Object.entries(initial));
  return {
    hasSecret(profileId, secretRef) {
      return table.has(secretRef) || table.has(profileId);
    },
    resolveSecretHandle(profileId, secretRef) {
      return table.get(secretRef) ?? table.get(profileId);
    }
  };
}

describe("provider profile credential schema", () => {
  it("should validate an openai-compatible profile carrying an opaque secret reference", () => {
    const profile = ProviderProfileSchema.parse({
      id: "openai-prod",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      secretRef: "op://vault/openai/api_key"
    });

    expect(profile.id).toBe("openai-prod");
    expect(profile.apiFormat).toBe("openai-chat-completions");
    expect(profile.secretRef).toBe("op://vault/openai/api_key");
  });

  it("should reject a profile that carries a literal secret value", () => {
    const result = ProviderProfileSchema.safeParse({
      id: "openai-prod",
      apiFormat: "openai-chat-completions",
      secretRef: "op://vault/openai/api_key",
      // Values belong in the vault, never on the profile record.
      secretValue: "sk-real-key"
    });

    expect(result.success).toBe(false);
  });

  it("should require a non-empty secret reference", () => {
    const result = ProviderProfileSchema.safeParse({
      id: "openai-prod",
      apiFormat: "openai-chat-completions",
      secretRef: ""
    });

    expect(result.success).toBe(false);
  });

  it("should accept a profile without a baseUrl (base defaults elsewhere)", () => {
    const profile = ProviderProfileSchema.parse({
      id: "anthropic-direct",
      apiFormat: "anthropic-messages",
      secretRef: "env:ANTHROPIC_API_KEY"
    });

    expect(profile.baseUrl).toBeUndefined();
  });
});

describe("profile credential store", () => {
  it("should isolate two openai-compatible profiles with distinct secrets", () => {
    const profileA: ProviderProfile = ProviderProfileSchema.parse({
      id: "openai-prod",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      secretRef: "openai-prod/key"
    });
    const profileB: ProviderProfile = ProviderProfileSchema.parse({
      id: "openai-personal",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      secretRef: "openai-personal/key"
    });

    const store = createProfileCredentialStore({
      profiles: [profileA, profileB],
      activeProfileId: "openai-prod",
      lookup: fakeLookup({
        "openai-prod/key": SENTINEL_A,
        "openai-personal/key": SENTINEL_B
      })
    });

    const a = resolveActiveCredentials(store);
    expect(a?.profileId).toBe("openai-prod");
    expect(a?.secretHandle).toBe(SENTINEL_A);

    // Switch active profile — isolation: B's resolve must not see A's handle.
    store.setActiveProfile("openai-personal");
    const b = resolveActiveCredentials(store);
    expect(b?.profileId).toBe("openai-personal");
    expect(b?.secretHandle).toBe(SENTINEL_B);
    expect(b?.secretHandle).not.toBe(SENTINEL_A);
  });

  it("should report the secret by opaque handle and never by value", () => {
    const store = createProfileCredentialStore({
      profiles: [
        ProviderProfileSchema.parse({
          id: "openai-prod",
          apiFormat: "openai-chat-completions",
          secretRef: "openai-prod/key"
        })
      ],
      activeProfileId: "openai-prod",
      lookup: fakeLookup({ "openai-prod/key": SENTINEL_A })
    });

    const resolved = resolveActiveCredentials(store)!;
    // The resolved record is a handle, not a value-bearing secret blob — and it
    // must not leak other profiles' material.
    expect(JSON.stringify(resolved)).toContain(SENTINEL_A);
    expect(JSON.stringify(resolved)).not.toContain(SENTINEL_B);
    expect(resolved).not.toHaveProperty("secretValue");
  });

  it("should throw when activating an unknown profile id", () => {
    const store = createProfileCredentialStore({
      profiles: [
        ProviderProfileSchema.parse({
          id: "openai-prod",
          apiFormat: "openai-chat-completions",
          secretRef: "openai-prod/key"
        })
      ],
      activeProfileId: "openai-prod",
      lookup: fakeLookup({})
    });

    expect(() => store.setActiveProfile("does-not-exist")).toThrow(/profile/);
  });

  it("should resolve to undefined when the active profile's secret is absent", () => {
    const store = createProfileCredentialStore({
      profiles: [
        ProviderProfileSchema.parse({
          id: "openai-prod",
          apiFormat: "openai-chat-completions",
          secretRef: "openai-prod/key"
        })
      ],
      activeProfileId: "openai-prod",
      lookup: fakeLookup({})
    });

    expect(resolveActiveCredentials(store)).toBeUndefined();
  });

  it("should reject duplicate profile ids at construction", () => {
    const profile = ProviderProfileSchema.parse({
      id: "openai-prod",
      apiFormat: "openai-chat-completions",
      secretRef: "openai-prod/key"
    });

    expect(() =>
      createProfileCredentialStore({
        profiles: [profile, { ...profile }],
        activeProfileId: "openai-prod",
        lookup: fakeLookup({})
      })
    ).toThrow(/duplicate/i);
  });

  it("should validate a snapshot with isolated per-profile secret refs", () => {
    const parsed = ProfileCredentialStoreSchema.parse({
      profiles: [
        { id: "openai-prod", apiFormat: "openai-chat-completions", secretRef: "openai-prod/key" },
        { id: "openai-personal", apiFormat: "openai-chat-completions", secretRef: "openai-personal/key" }
      ],
      activeProfileId: "openai-prod"
    });

    expect(parsed.profiles).toHaveLength(2);
    expect(parsed.activeProfileId).toBe("openai-prod");
  });
});
