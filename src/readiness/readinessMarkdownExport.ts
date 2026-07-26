import { scrubSecretValues } from "../safety/secretSafety.js";
import type { ReadinessReport, ReadinessRow } from "./schemas.js";

/**
 * Pure readiness snapshot → markdown renderer for fleet/status surfaces.
 *
 * Renders the snapshot as a deterministic, human-readable markdown report:
 * - top-level `# Readiness:` heading with the runtime, version, generatedAt, and overall verdict
 * - a `## Score` section summarising the GREEN/total ratio
 * - one `## <row title>` heading per readiness row carrying verdict, status, and category
 * - a `### Gap` sub-section for rows that have missing env names, missing-command evidence,
 *   or a stated next action
 *
 * The function is pure and side-effect-free: identical inputs produce byte-identical output.
 * Env names remain visible, while snapshot text is passed through the structural secret scrubber
 * before it reaches markdown.
 */
export function toReadinessMarkdown(snapshot: ReadinessReport): string {
  const lines: string[] = [];

  lines.push(`# Readiness: ${snapshot.verdict} — ${safe(snapshot.runtimeName)}${snapshot.runtimeVersion ? ` ${safe(snapshot.runtimeVersion)}` : ""}`);
  lines.push("");
  lines.push(`Generated at \`${safe(snapshot.generatedAt)}\`.`);
  lines.push("");

  const greenCount = snapshot.rows.filter((row) => row.verdict === "GREEN").length;
  lines.push("## Score");
  lines.push("");
  lines.push(`- **Verdict:** ${snapshot.verdict}`);
  lines.push(`- **GREEN rows:** ${greenCount}/${snapshot.rows.length}`);
  lines.push(`- **Summary:** ${safe(snapshot.summary)}`);
  lines.push("");

  for (const row of snapshot.rows) {
    lines.push(renderRowHeading(row));
    lines.push("");
    lines.push(...renderRowBody(row));
    lines.push("");
  }

  // Trim a single trailing newline so the output is deterministic and doesn't grow per call.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n") + "\n";
}

function renderRowHeading(row: ReadinessRow): string {
  return `## ${safe(row.title)} — ${row.verdict} (${row.status})`;
}

function renderRowBody(row: ReadinessRow): string[] {
  const lines: string[] = [];

  lines.push(`- **Category:** \`${row.category}\``);
  lines.push(`- **Owner:** \`${safe(row.ownerModule)}\``);
  lines.push(`- **Status:** \`${row.status}\``);
  lines.push(`- **Verdict:** \`${row.verdict}\``);
  lines.push(`- **Summary:** ${safe(row.summary)}`);

  if (row.evidence.length > 0) {
    lines.push(`- **Evidence:**`);
    for (const item of row.evidence) {
      lines.push(`  - ${safe(item)}`);
    }
  }

  const gapLines = renderGap(row);
  if (gapLines.length > 0) {
    lines.push("");
    lines.push("### Gap");
    lines.push("");
    lines.push(...gapLines);
  }

  return lines;
}

function renderGap(row: ReadinessRow): string[] {
  const lines: string[] = [];

  if (row.missingEnvNames.length > 0) {
    lines.push(`- **Missing env:** ${row.missingEnvNames.map((name) => `\`${name}\``).join(", ")}`);
  }

  if (row.status === "missing-command") {
    lines.push("- **Missing command:** the owning CLI/binary is not on PATH.");
  }

  if (row.status === "missing-config") {
    lines.push("- **Missing config:** the owning config surface has not been provided.");
  }

  if (row.status === "offline") {
    lines.push("- **Offline:** the owning service is unreachable from the current environment.");
  }

  if (row.nextAction) {
    lines.push(`- **Next action:** ${row.nextAction}`);
  }

  return lines;
}