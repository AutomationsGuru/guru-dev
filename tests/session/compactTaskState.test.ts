import { describe, expect, it } from "vitest";

import {
  extractTaskMarkers,
  preserveTaskStateThroughCompact,
  TASK_MARKER_PREFIX,
  type PreCompactTaskState,
  type TaskMarker
} from '../../src/session/compactTaskState.js';
import type { TranscriptEntry } from '../../src/compaction/schemas.js';

// --- helpers ----------------------------------------------------------------

function marker(id: string, over: Partial<Pick<TaskMarker, "title" | "status">> = {}): TaskMarker {
  return {
    id,
    title: over.title ?? `Task ${id}`,
    status: over.status ?? "pending"
  };
}

function summaryEntry(count = 1, content = "compacted history summary"): TranscriptEntry {
  return {
    id: `summary-${count}`,
    kind: "system",
    content: `[compaction summary] (${count} compaction; ~500 tok folded)\n${content}`
  };
}

function keptEntry(id: string, content: string, kind: TranscriptEntry["kind"] = "assistant"): TranscriptEntry {
  return { id, kind, content };
}

function hasMarkerEntry(entries: readonly TranscriptEntry[]): boolean {
  return entries.some(
    (entry) => entry.kind === "system" && entry.content.startsWith(TASK_MARKER_PREFIX)
  );
}

function findMarkerEntry(entries: readonly TranscriptEntry[]): TranscriptEntry | undefined {
  return entries.find(
    (entry) => entry.kind === "system" && entry.content.startsWith(TASK_MARKER_PREFIX)
  );
}

// --- tests ------------------------------------------------------------------

describe("compactTaskState — task marker preservation through compaction", () => {
  // -- empty markers ---------------------------------------------------------
  it("returns a distinct copy when markers are empty (no injection)", () => {
    const before: PreCompactTaskState = { markers: [] };
    const after = [summaryEntry(), keptEntry("e1", "hello")];

    const result = preserveTaskStateThroughCompact(before, after);

    expect(result).not.toBe(after); // distinct copy
    expect(result).toEqual(after);
    expect(hasMarkerEntry(result)).toBe(false);
  });

  // -- single marker ---------------------------------------------------------
  it("injects a single task marker as a system entry after the compaction summary", () => {
    const before: PreCompactTaskState = { markers: [marker("t1")] };
    const after = [summaryEntry(), keptEntry("e1", "assistant reply")];

    const result = preserveTaskStateThroughCompact(before, after);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(after[0]); // summary still first
    expect(result[1]?.kind).toBe("system");
    expect(result[1]?.content).toContain(TASK_MARKER_PREFIX);
    expect(result[2]).toEqual(after[1]); // kept entry after markers
  });

  // -- multiple markers ------------------------------------------------------
  it("preserves multiple task markers in a single system entry", () => {
    const markers: TaskMarker[] = [
      marker("t1", { title: "Fix auth bug", status: "in_progress" }),
      marker("t2", { title: "Add dark mode", status: "pending" }),
      marker("t3", { title: "Review PR #42", status: "blocked" })
    ];
    const before: PreCompactTaskState = { markers };
    const after = [summaryEntry(), keptEntry("e1", "hello")];

    const result = preserveTaskStateThroughCompact(before, after);
    const recovered = extractTaskMarkers(result);

    expect(recovered).toHaveLength(3);
    expect(recovered).toEqual(markers);
  });

  // -- all statuses ----------------------------------------------------------
  it("preserves markers regardless of status value", () => {
    const markers: TaskMarker[] = [
      marker("a", { status: "pending" }),
      marker("b", { status: "in_progress" }),
      marker("c", { status: "completed" }),
      marker("d", { status: "blocked" })
    ];
    const before: PreCompactTaskState = { markers };
    const after = [summaryEntry()];

    const result = preserveTaskStateThroughCompact(before, after);
    const recovered = extractTaskMarkers(result);

    expect(recovered).toEqual(markers);
    expect(recovered.map((m) => m.status)).toEqual([
      "pending",
      "in_progress",
      "completed",
      "blocked"
    ]);
  });

  // -- no summary entry ------------------------------------------------------
  it("prepends markers when no compaction summary entry exists in afterEntries", () => {
    const before: PreCompactTaskState = { markers: [marker("t1")] };
    const after = [keptEntry("e1", "some message", "user")];

    const result = preserveTaskStateThroughCompact(before, after);

    expect(result).toHaveLength(2);
    expect(result[0]?.kind).toBe("system");
    expect(result[0]?.content).toContain(TASK_MARKER_PREFIX);
    expect(result[1]).toEqual(after[0]);
  });

  // -- markers insert right after summary, before kept entries ----------------
  it("inserts markers between the summary entry and the first kept entry", () => {
    const before: PreCompactTaskState = { markers: [marker("m1")] };
    const after = [
      summaryEntry(),
      keptEntry("e5", "recent user message", "user"),
      keptEntry("e6", "recent assistant reply", "assistant")
    ];

    const result = preserveTaskStateThroughCompact(before, after);

    expect(result).toHaveLength(4);
    // summary → markers → user → assistant
    expect(result[0]?.id).toBe("summary-1");
    expect(result[1]?.id).toBe("task-markers");
    expect(result[2]?.id).toBe("e5");
    expect(result[3]?.id).toBe("e6");
  });

  // -- extractTaskMarkers: no markers ----------------------------------------
  it("extractTaskMarkers returns an empty array when no marker entry is present", () => {
    const entries: TranscriptEntry[] = [
      summaryEntry(),
      keptEntry("e1", "hello"),
      keptEntry("e2", "world")
    ];

    expect(extractTaskMarkers(entries)).toEqual([]);
  });

  it("extractTaskMarkers returns an empty array for an empty transcript", () => {
    expect(extractTaskMarkers([])).toEqual([]);
  });

  // -- extractTaskMarkers: malformed -----------------------------------------
  it("extractTaskMarkers returns an empty array when the marker content is not valid JSON", () => {
    const entries: TranscriptEntry[] = [
      {
        id: "task-markers",
        kind: "system",
        content: `${TASK_MARKER_PREFIX}\nnot-json-at-all`
      }
    ];

    expect(extractTaskMarkers(entries)).toEqual([]);
  });

  it("extractTaskMarkers returns an empty array when the marker content is JSON but not an array", () => {
    const entries: TranscriptEntry[] = [
      {
        id: "task-markers",
        kind: "system",
        content: `${TASK_MARKER_PREFIX}\n{"id":"not-an-array"}`
      }
    ];

    expect(extractTaskMarkers(entries)).toEqual([]);
  });

  // -- round-trip: inject → extract ------------------------------------------
  it("round-trips markers: injected markers are byte-identical after extraction", () => {
    const markers: TaskMarker[] = [
      { id: "abc-123", title: "Implement F319", status: "in_progress" },
      { id: "def-456", title: "Write docs", status: "pending" }
    ];
    const before: PreCompactTaskState = { markers };
    const after = [summaryEntry(2, "previous work summarized"), keptEntry("e10", "ok")];

    const result = preserveTaskStateThroughCompact(before, after);
    const recovered = extractTaskMarkers(result);

    expect(recovered).toEqual(markers);
    // Verify field-level equality (not just deep-equal reference).
    expect(recovered[0]?.id).toBe("abc-123");
    expect(recovered[0]?.title).toBe("Implement F319");
    expect(recovered[0]?.status).toBe("in_progress");
    expect(recovered[1]?.id).toBe("def-456");
    expect(recovered[1]?.title).toBe("Write docs");
    expect(recovered[1]?.status).toBe("pending");
  });

  // -- marker entry id is stable ---------------------------------------------
  it("uses a stable marker entry id for recognition and dedup", () => {
    const before: PreCompactTaskState = { markers: [marker("x")] };
    const after = [summaryEntry()];

    const result = preserveTaskStateThroughCompact(before, after);
    const markerEntry = findMarkerEntry(result);

    expect(markerEntry).toBeDefined();
    expect(markerEntry?.id).toBe("task-markers");
  });

  // -- preserves marker content with special characters -----------------------
  it("preserves marker titles containing special characters and whitespace", () => {
    const markers: TaskMarker[] = [
      { id: "t1", title: "Fix: login redirect (OAuth) — v2.0", status: "in_progress" },
      { id: "t2", title: "Handle edge case: empty string \"\" input", status: "pending" }
    ];
    const before: PreCompactTaskState = { markers };
    const after = [summaryEntry()];

    const recovered = extractTaskMarkers(preserveTaskStateThroughCompact(before, after));

    expect(recovered).toEqual(markers);
  });

  // -- compaction with multiple summaries (iterative compaction) --------------
  it("inserts after the FIRST summary entry when multiple exist", () => {
    const before: PreCompactTaskState = { markers: [marker("m1")] };
    const after = [
      summaryEntry(1, "first compaction"),
      summaryEntry(2, "second compaction"),
      keptEntry("e1", "recent message")
    ];

    const result = preserveTaskStateThroughCompact(before, after);

    // Should insert after the first summary (index 0), so order is:
    // summary-1 → markers → summary-2 → e1
    expect(result).toHaveLength(4);
    expect(result[0]?.id).toBe("summary-1");
    expect(result[1]?.id).toBe("task-markers");
    expect(result[2]?.id).toBe("summary-2");
    expect(result[3]?.id).toBe("e1");
  });
});
