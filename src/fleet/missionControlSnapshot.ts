/**
 * MissionControlSnapshot — pure aggregate of agent statuses to markdown table.
 *
 * Deterministic: always sorts by agent id for stable output (critical for
 * snapshot diffing and mission-control rendering). No side effects, no I/O.
 *
 * Fits GuruHarness vision: lightweight, owned runtime, no external deps,
 * focused on one seam (status reporting for fleet coordination).
 */

export interface AgentStatus {
  readonly id: string;
  readonly role?: string;
  readonly state: string; // e.g. "idle" | "running" | "error" | "done"
  readonly lastActivity?: string;
  readonly taskPreview?: string;
}

/**
 * toMarkdown renders a sorted markdown table of agent statuses for
 * mission-control overview. Empty input yields a clean "no agents" message.
 */
export function toMarkdown(agents: readonly AgentStatus[]): string {
  if (!agents || agents.length === 0) {
    return "# Mission Control Snapshot\n\n_No active agents._";
  }

  // Deterministic order: stable sort by id (localeCompare for cross-platform)
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));

  const lines: string[] = [
    "# Mission Control Snapshot",
    "",
    "| ID | Role | State | Last Activity | Task Preview |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const a of sorted) {
    const role = a.role ?? "-";
    const last = a.lastActivity ?? "-";
    const preview = a.taskPreview ? a.taskPreview.slice(0, 40) + (a.taskPreview.length > 40 ? "…" : "") : "-";
    lines.push(`| ${a.id} | ${role} | ${a.state} | ${last} | ${preview} |`);
  }

  return lines.join("\n");
}
