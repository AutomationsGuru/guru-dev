/**
 * Metadata for a host credential slot.
 *
 * The slot deliberately exposes presence only: credential values are neither
 * accepted nor inspected by this check.
 */
export interface HostCredentialSlotMeta {
  readonly present: boolean;
}

/**
 * Returns whether the host reports a credential in the specified slot.
 */
export function hasCredential(slotMeta: HostCredentialSlotMeta): boolean {
  return slotMeta.present;
}
