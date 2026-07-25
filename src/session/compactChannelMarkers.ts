import type { ChatTurnMessage } from "../model/directChat.js";

/**
 * Prefix that identifies a named channel/log marker entry in the transcript.
 * Channel markers are system messages scoped to compact-preservation: when the
 * compaction engine folds old transcript entries and replaces them with a
 * summary, these markers survive and are reattached to the result so named
 * channel-position references stay intact.
 *
 * Format: `[channel marker: <name>]` followed by an optional body.
 */
export const CHANNEL_MARKER_PREFIX = "[channel marker:";

/**
 * True when a system message is a named channel marker.
 */
export function isChannelMarker(msg: ChatTurnMessage): boolean {
  return msg.role === "system" && msg.content.startsWith(CHANNEL_MARKER_PREFIX);
}

/**
 * Reattach channel markers from the pre-compaction transcript into the
 * post-compaction result so named channel/log markers survive transcript
 * replacement (F319 sibling — compact preserves channel markers).
 *
 * Markers present in `before` but absent from `after` are reinserted after the
 * compaction summary entry and before the first non-system kept message.
 * Markers already present in `after` are not duplicated.
 */
export function preserveChannelMarkers(
  before: readonly ChatTurnMessage[],
  after: readonly ChatTurnMessage[]
): ChatTurnMessage[] {
  const markers = before.filter(isChannelMarker);
  if (markers.length === 0) return [...after];

  // Only reattach markers not already present in the result.
  const existing = new Set(after.map((m) => m.content));
  const missing = markers.filter((m) => !existing.has(m.content));
  if (missing.length === 0) return [...after];

  // Find the insertion point: right after the compaction summary entry (a
  // system message starting with "[compaction summary]"). When no compaction
  // summary is present, markers go at the front.
  let insertAt = 0;
  for (let i = 0; i < after.length; i++) {
    const message = after[i] as ChatTurnMessage;
    if (message.role === "system" && message.content.startsWith("[compaction summary]")) {
      insertAt = i + 1;
      break;
    }
  }
  if (insertAt === 0) {
    insertAt = after.length;
  }

  const result = [...after];
  result.splice(insertAt, 0, ...missing);
  return result;
}
