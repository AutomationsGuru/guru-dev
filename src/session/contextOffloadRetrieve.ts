/**
 * Expand session-scoped offload references for operator inspection without
 * changing unreferenced transcript text. The ref syntax matches the sibling
 * session offload store; unknown refs stay visible as an availability note.
 */
export function expandPointers(text: string, store: ReadonlyMap<string, string>): string {
  return text.replace(/offload:\d+/g, (ref) => store.get(ref) ?? `[offloaded content unavailable: ${ref}]`);
}
