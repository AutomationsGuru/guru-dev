import { describe, expect, it } from "vitest";

import type { TranscriptEntry } from '../../src/compaction/schemas.js';
import {
  extractTaskMarkers,
  preserve,
  TASK_MARKER_PREFIX,
  type PreCompactTaskState,
  type TaskMarker
} from '../../src/session/compactTaskStatePreserve.js';

function marker(id: string, status: TaskMarker["status"] = "pending"): TaskMarker {
  return { id, title: `Task ${id}`, status };
}

function summary(): TranscriptEntry {
  return {
    id: "summary-1",
    kind: "system",
    content: "[compaction summary] (1 compaction; ~100 tok folded)\nOlder work"
  };
}

function kept(id: string, kind: TranscriptEntry["kind"] = "assistant"): TranscriptEntry {
  return { id, kind, content: `kept ${id}` };
}

describe("compact task-state preservation", () => {
  it("reattaches every marker after the compaction summary in source order", () => {
    const before: PreCompactTaskState = {
      markers: [
        marker("one", "in_progress"),
        marker("two", "pending"),
        marker("three", "completed"),
        marker("four", "blocked")
      ]
    };
    const after = [summary(), kept("recent-user", "user"), kept("recent-answer")];

    const result = preserve(before, after);

    expect(result[0]).toEqual(after[0]);
    expect(result[1]?.id).toBe("task-markers");
    expect(result[2]).toEqual(after[1]);
    expect(result[3]).toEqual(after[2]);
    expect(extractTaskMarkers(result)).toEqual(before.markers);
  });

  it("reattaches markers at the front when no summary survived", () => {
    const before: PreCompactTaskState = { markers: [marker("one")] };
    const after = [kept("recent", "user")];

    expect(preserve(before, after)).toEqual([
      {
        id: "task-markers",
        kind: "system",
        content: `${TASK_MARKER_PREFIX}\n${JSON.stringify(before.markers)}`
      },
      ...after
    ]);
  });

  it("replaces an existing marker snapshot instead of duplicating stale state", () => {
    const before: PreCompactTaskState = { markers: [marker("fresh", "in_progress")] };
    const after = [
      summary(),
      {
        id: "task-markers",
        kind: "system" as const,
        content: `${TASK_MARKER_PREFIX}\n${JSON.stringify([marker("stale")])}`
      },
      kept("recent")
    ];

    const result = preserve(before, after);

    expect(result).toHaveLength(after.length);
    expect(result.filter((entry) => entry.id === "task-markers")).toHaveLength(1);
    expect(extractTaskMarkers(result)).toEqual(before.markers);
  });

  it("returns a new unchanged transcript when there are no markers", () => {
    const before: PreCompactTaskState = { markers: [] };
    const after = [summary(), kept("recent")];

    const result = preserve(before, after);

    expect(result).toEqual(after);
    expect(result).not.toBe(after);
  });

  it("does not mutate the pre- or post-compaction inputs", () => {
    const before: PreCompactTaskState = { markers: [marker("one")] };
    const after = [summary(), kept("recent")];
    const beforeMarkers = [...before.markers];
    const afterEntries = [...after];

    preserve(before, after);

    expect(before.markers).toEqual(beforeMarkers);
    expect(after).toEqual(afterEntries);
  });

  it("fails closed when the marker payload is malformed", () => {
    expect(
      extractTaskMarkers([
        {
          id: "task-markers",
          kind: "system",
          content: `${TASK_MARKER_PREFIX}\n{not-json}`
        }
      ])
    ).toEqual([]);

    expect(
      extractTaskMarkers([
        {
          id: "task-markers",
          kind: "system",
          content: `${TASK_MARKER_PREFIX}\n${JSON.stringify([{ id: "x", title: "missing status" }])}`
        }
      ])
    ).toEqual([]);
  });
});
