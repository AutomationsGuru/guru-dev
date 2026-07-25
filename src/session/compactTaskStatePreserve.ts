import type { TranscriptEntry } from "../compaction/schemas.js";

/** A named unit of work that must survive transcript compaction. */
export interface TaskMarker {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in_progress" | "completed" | "blocked";
}

/** The authoritative task state captured before the transcript is compacted. */
export interface PreCompactTaskState {
  readonly markers: readonly TaskMarker[];
}

/** Stable prefix used to identify the structured task-state transcript entry. */
export const TASK_MARKER_PREFIX = "[task-state preserve]";

const TASK_MARKER_ENTRY_ID = "task-markers";

function isTaskMarker(value: unknown): value is TaskMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.id === "string" &&
    marker.id.trim().length > 0 &&
    typeof marker.title === "string" &&
    typeof marker.status === "string" &&
    (marker.status === "pending" ||
      marker.status === "in_progress" ||
      marker.status === "completed" ||
      marker.status === "blocked")
  );
}

function taskMarkerEntry(markers: readonly TaskMarker[]): TranscriptEntry {
  return {
    id: TASK_MARKER_ENTRY_ID,
    kind: "system",
    content: `${TASK_MARKER_PREFIX}\n${JSON.stringify(markers)}`
  };
}

function isTaskMarkerEntry(entry: TranscriptEntry): boolean {
  return entry.kind === "system" && entry.content.startsWith(TASK_MARKER_PREFIX);
}

function isCompactionSummaryEntry(entry: TranscriptEntry): boolean {
  return entry.kind === "system" && entry.content.startsWith("[compaction summary]");
}

/**
 * Reattach the authoritative task markers after a transcript replacement.
 *
 * The returned array is always new and the input transcript is never mutated.
 * A marker entry already present in the kept transcript is replaced rather than
 * duplicated, so a second compaction cannot accumulate stale task snapshots.
 */
export function preserve(before: PreCompactTaskState, after: readonly TranscriptEntry[]): TranscriptEntry[] {
  const result = [...after];
  if (before.markers.length === 0) {
    return result;
  }

  const entry = taskMarkerEntry(before.markers);
  const existingIndex = result.findIndex(isTaskMarkerEntry);
  if (existingIndex >= 0) {
    result[existingIndex] = entry;
    return result;
  }

  const summaryIndex = result.findIndex(isCompactionSummaryEntry);
  result.splice(summaryIndex >= 0 ? summaryIndex + 1 : 0, 0, entry);
  return result;
}

/** Compatibility name for callers that describe the operation verbosely. */
export const preserveTaskStateThroughCompact = preserve;

/** Recover a valid task-marker snapshot from a compacted transcript. */
export function extractTaskMarkers(entries: readonly TranscriptEntry[]): TaskMarker[] {
  const entry = entries.find(isTaskMarkerEntry);
  if (!entry) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(entry.content.slice(TASK_MARKER_PREFIX.length).trim());
    return Array.isArray(parsed) && parsed.every(isTaskMarker) ? parsed : [];
  } catch {
    return [];
  }
}
