export interface OperatorReadinessSnapshotEntry {
  readonly id: string;
  readonly status: string;
  readonly detail?: string;
}

export interface OperatorReadinessSnapshot {
  readonly readiness: readonly OperatorReadinessSnapshotEntry[];
  readonly auth: readonly OperatorReadinessSnapshotEntry[];
  readonly skills: readonly OperatorReadinessSnapshotEntry[];
  readonly pendingFlags: readonly OperatorReadinessSnapshotEntry[];
}

const SECTIONS: readonly [string, keyof OperatorReadinessSnapshot][] = [
  ["Readiness", "readiness"],
  ["Auth", "auth"],
  ["Skills", "skills"],
  ["Pending flags", "pendingFlags"]
];

/** Renders a deterministic, copyable operator handoff without inspecting live state. */
export function toMarkdown(snapshot: OperatorReadinessSnapshot): string {
  const lines = ["# Operator readiness snapshot"];

  for (const [title, key] of SECTIONS) {
    lines.push("", `## ${title}`, "");
    const entries = [...snapshot[key]].sort((left, right) => left.id.localeCompare(right.id));

    if (entries.length === 0) {
      lines.push("None.");
      continue;
    }

    lines.push("| Id | Status | Detail |", "| --- | --- | --- |");
    for (const entry of entries) {
      lines.push(`| ${escapeCell(entry.id)} | ${escapeCell(entry.status)} | ${escapeCell(entry.detail ?? "")} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}
