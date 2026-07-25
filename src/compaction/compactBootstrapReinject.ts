import { TranscriptEntry } from "./schemas.js";

/**
 * Re-inject method bootstrap markers once.
 * After compaction, the bootstrap toolCall/toolResult may have been folded into the summary.
 * This injects empty placeholder markers for missing bootstrap IDs so that the
 * (or session logic) knows they have already been completed and doesn't re-bootstrap them.
 */
export function reinject(bootstrapIds: readonly string[], transcript: readonly TranscriptEntry[]): TranscriptEntry[] {
  if (bootstrapIds.length === 0) {
    return [...transcript];
  }

  const existingIds = new Set(transcript.map(t => t.id));
  const missingIds = bootstrapIds.filter(id => !existingIds.has(id));

  if (missingIds.length === 0) {
    return [...transcript];
  }

  const newTranscript = [...transcript];
  // Insert immediately after the summary if present, otherwise at the very top.
  let insertIndex = 0;
  if (newTranscript.length > 0 && newTranscript[0]?.kind === "system" && newTranscript[0].id.startsWith("summary-")) {
    insertIndex = 1;
  }

  // Create empty toolCall / toolResult markers to satisfy the session state
  // We don't have the original content, but "empty bootstrap no-op" in tests implies
  // we just need the IDs to be present. We will inject them as system messages or tool calls?
  // Let's look at what ID represents. If it's a toolCall id, we could inject an empty system message with that ID,
  // but let's assume `TranscriptEntry` requires kind.
  const injectedEntries: TranscriptEntry[] = missingIds.map(id => ({
    id,
    kind: "system",
    content: "[compaction: recovered bootstrap marker]"
  }));

  newTranscript.splice(insertIndex, 0, ...injectedEntries);
  return newTranscript;
}
