import type { TranscriptEntry } from "../compaction/schemas.js";

/**
 * Compact task-state preserve — after context compaction, named task/work markers
 * remain in the session snapshot (IDEA-F319-COMPACT-TASK-01 / R-OH-COMPACT-TASK).
 *
 * Task markers are structured fields (id, title, status) defined outside free-form
 * chat text. When the chat body is compacted into a summary, these markers are
 * injected as a structured system entry so they survive into the post-compact
 * snapshot and the next session knows what tasks were active.
 */

/** A named work marker tracked by the agent during a session. */
export interface TaskMarker {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in_progress" | "completed" | "blocked";
}

/** Pre-compaction state carrying active task markers to preserve through the fold. */
export interface PreCompactTaskState {
  readonly markers: readonly TaskMarker[];
}

/** Marker prefix so markers can be recognized (and later extracted or replaced). */
export const TASK_MARKER_PREFIX = "[task-state preserve]";

/**
 * Inject active task markers into the post-compaction transcript as a structured
 * system entry so they survive the fold even though the chat body that contained
 * them was replaced by a summary.
 *
 * The marker entry is inserted immediately after the compaction summary entry
 * (when present) so it stays bundled with the summary rather than trailing at the
 * end of the transcript.
 *
 * @param before  Pre-compaction state carrying the active task markers.
 * @param afterEntries  Post-compaction transcript (summary entry + kept entries).
 * @returns A new transcript array with the task marker entry injected.
 */
export function preserveTaskStateThroughCompact(
  before: PreCompactTaskState,
  afterEntries: readonly TranscriptEntry[]
): TranscriptEntry[] {
  if (before.markers.length === 0) {
    return [...afterEntries];
  }

  const markerEntry: TranscriptEntry = {
    id: "task-markers",
    kind: "system",
    content: `${TASK_MARKER_PREFIX}\n${JSON.stringify(before.markers)}`
  };

  // Find the compaction summary entry so we can insert markers right after it,
  // keeping the summary + markers bundled before the kept entries.
  const summaryIndex = afterEntries.findIndex(
    (entry) => entry.kind === "system" && entry.content.startsWith("[compaction summary]")
  );

  if (summaryIndex >= 0) {
    const result = [...afterEntries];
    result.splice(summaryIndex + 1, 0, markerEntry);
    return result;
  }

  // No summary entry found — prepend markers so they are not lost.
  return [markerEntry, ...afterEntries];
}

/**
 * Recover task markers from a transcript that may contain a preserved marker entry.
 * Returns an empty array when no marker entry is present or when parsing fails.
 */
export function extractTaskMarkers(entries: readonly TranscriptEntry[]): TaskMarker[] {
  for (const entry of entries) {
    if (entry.kind === "system" && entry.content.startsWith(TASK_MARKER_PREFIX)) {
      try {
        const json = entry.content.slice(TASK_MARKER_PREFIX.length).trim();
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) {
          return [];
        }
        return parsed as TaskMarker[];
      } catch {
        return [];
      }
    }
  }
  return [];
}
