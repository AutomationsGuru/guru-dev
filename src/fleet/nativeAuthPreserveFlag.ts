/** Metadata accepted from an external harness without importing its credentials. */
export type NativeAuthSessionMetadata = Readonly<Record<string, unknown>>;

export interface AttachedNativeAuthSession {
  /** The caller-owned metadata stays external to the Guru credential store. */
  readonly metadata: NativeAuthSessionMetadata;
  /** Signals that the source harness retains ownership of native authentication. */
  readonly preserveNativeAuth: true;
}

/**
 * Attach an external session while preserving its native authentication boundary.
 * A declared `secrets` field is rejected by shape, before any value can enter
 * Guru-owned session metadata.
 */
export function attachSession(metadata: NativeAuthSessionMetadata): AttachedNativeAuthSession {
  if (Object.hasOwn(metadata, "secrets")) {
    throw new Error("Native-auth session metadata cannot include a secrets field.");
  }

  return { metadata, preserveNativeAuth: true };
}
