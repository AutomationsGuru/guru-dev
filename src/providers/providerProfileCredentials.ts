import { z } from "zod";

import { ApiFamilySchema, type ApiFamily } from "./schemas.js";

/**
 * F486 — provider profile credentials (R-OH-PROFCRED).
 *
 * Each NAMED provider profile holds its own secret handle; activating profile B
 * never uses profile A's key. A profile record carries only an OPAQUE
 * `secretRef` (a vault/env/op handle that names WHERE a value lives) — never the
 * value itself. Values are resolved at call time through the injected lookup
 * and returned as an opaque `secretHandle`, never printed, logged, or persisted.
 *
 * Credential discipline (matches catalog.ts / schemas.ts): env NAMES / file
 * PRESENCE only; a structural `secretValuePresent: z.never()` guard rejects any
 * literal secret value placed on a profile record.
 *
 * Primary plan API: {@link resolveActive}(store, id).
 */

export const ProviderProfileSchema = z
  .object({
    /** Stable, unique profile id (e.g. "openai-prod", "openai-personal"). */
    id: z.string().min(1),
    /** Wire/api family the profile speaks — reuses the catalog ApiFamily enum. */
    apiFormat: ApiFamilySchema,
    /** Optional base URL override (otherwise a family default applies). */
    baseUrl: z.string().min(1).optional(),
    /**
     * Opaque reference that names WHERE the secret lives (vault path, env name,
     * op:// ref). Never carries a value; resolved by the lookup at call time.
     */
    secretRef: z.string().min(1),
    /** Structural guard: a profile record never carries a literal secret value. */
    secretValuePresent: z.never().optional()
  })
  .strict();

export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type ProviderProfileInput = z.input<typeof ProviderProfileSchema>;

export const ProviderProfileCredentialStoreSchema = z
  .object({
    profiles: z.array(ProviderProfileSchema).min(1),
    activeProfileId: z.string().min(1),
    secretValuePresent: z.never().optional()
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const profile of value.profiles) {
      if (ids.has(profile.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate provider profile id: ${profile.id}`,
          path: ["profiles"]
        });
      }
      ids.add(profile.id);
    }

    if (!ids.has(value.activeProfileId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `activeProfileId '${value.activeProfileId}' does not match any profile id.`,
        path: ["activeProfileId"]
      });
    }
  });

export type ProviderProfileCredentialStoreSnapshot = z.infer<
  typeof ProviderProfileCredentialStoreSchema
>;

/**
 * Fakeable secret resolver. The store does not know HOW a handle is resolved —
 * it delegates to this lookup so unit tests inject a fake store and the runtime
 * injects the real vault. The lookup receives both `profileId` and `secretRef`
 * so it can resolve per-profile without the store ever materializing values.
 */
export interface ProfileCredentialLookup {
  /** Report whether a usable secret handle exists for the profile/reference. */
  hasSecret(profileId: string, secretRef: string): boolean;
  /**
   * Return the opaque secret handle for the profile/reference, or `undefined`
   * when absent. The returned handle is passed straight to the wire layer and is
   * never inspected for content by the resolver.
   */
  resolveSecretHandle(profileId: string, secretRef: string): string | undefined;
}

/**
 * A resolved, ready-to-send credential for the active profile. `secretHandle` is
 * opaque; it is not a value-bearing secret blob and carries no `secretValue`
 * property. The wire layer consumes the handle; nothing logs it.
 */
export interface ActiveProfileCredentials {
  readonly profileId: string;
  readonly apiFormat: ApiFamily;
  readonly baseUrl?: string;
  readonly secretRef: string;
  readonly secretHandle: string;
}

export interface ProviderProfileCredentialStore {
  /** Snapshot (no secret values) of the configured profiles + active id. */
  readonly snapshot: ProviderProfileCredentialStoreSnapshot;
  /** Currently active profile id. */
  readonly activeProfileId: string;
  /** All profiles, in registration order. */
  readonly profiles: readonly ProviderProfile[];
  /** Look up a profile by id. */
  getProfile(profileId: string): ProviderProfile | undefined;
  /** Activate a different profile; throws if the id is unknown. */
  setActiveProfile(profileId: string): void;
  /** Inject/replace the secret lookup (e.g. after a vault unlock). */
  setLookup(lookup: ProfileCredentialLookup): void;
  /**
   * Resolve ONLY this store's active profile secret handle, or `undefined` when
   * absent. Lives on the store object so resolution always sees the current
   * active id + lookup without hidden state.
   */
  resolveActiveCredentials(): ActiveProfileCredentials | undefined;
}

export interface CreateProviderProfileCredentialStoreOptions {
  profiles: readonly (ProviderProfile | ProviderProfileInput)[];
  activeProfileId: string;
  lookup: ProfileCredentialLookup;
}

function normalizeProfile(profile: ProviderProfile | ProviderProfileInput): ProviderProfile {
  return ProviderProfileSchema.parse(profile);
}

export function createProviderProfileCredentialStore(
  options: CreateProviderProfileCredentialStoreOptions
): ProviderProfileCredentialStore {
  const parsed = ProviderProfileCredentialStoreSchema.parse({
    profiles: options.profiles.map(normalizeProfile),
    activeProfileId: options.activeProfileId
  });

  const profilesById = new Map<string, ProviderProfile>(
    parsed.profiles.map((profile) => [profile.id, profile])
  );
  let activeProfileId = parsed.activeProfileId;
  let lookup = options.lookup;

  return {
    get snapshot() {
      return { profiles: [...profilesById.values()], activeProfileId };
    },
    get activeProfileId() {
      return activeProfileId;
    },
    get profiles() {
      return [...profilesById.values()];
    },
    getProfile(profileId) {
      return profilesById.get(profileId);
    },
    setActiveProfile(profileId) {
      if (!profilesById.has(profileId)) {
        throw new Error(`Unknown provider profile: ${profileId}`);
      }
      activeProfileId = profileId;
    },
    setLookup(nextLookup) {
      lookup = nextLookup;
    },
    resolveActiveCredentials() {
      const profile = profilesById.get(activeProfileId);
      if (!profile) {
        return undefined;
      }
      if (!lookup.hasSecret(profile.id, profile.secretRef)) {
        return undefined;
      }
      const secretHandle = lookup.resolveSecretHandle(profile.id, profile.secretRef);
      if (secretHandle === undefined) {
        return undefined;
      }
      return {
        profileId: profile.id,
        apiFormat: profile.apiFormat,
        ...(profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {}),
        secretRef: profile.secretRef,
        secretHandle
      };
    }
  };
}

/**
 * Resolve ONLY the named (or currently active) profile's secret handle.
 * Returns `undefined` when the profile has no usable secret (missing-credential).
 *
 * Crucially, this resolves exactly one profile's reference and returns exactly
 * that handle — activating B can never yield A's key.
 *
 * Plan API: `resolveActive(store, id)`.
 */
export function resolveActive(
  store: ProviderProfileCredentialStore,
  id?: string
): ActiveProfileCredentials | undefined {
  if (id !== undefined && id !== store.activeProfileId) {
    store.setActiveProfile(id);
  }
  return store.resolveActiveCredentials();
}

/** Alias retained for callers that prefer the longer name. */
export const resolveActiveCredentials = resolveActive;
