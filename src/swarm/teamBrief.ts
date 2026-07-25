import { TeamBriefSchema, clampAllowlist, type TeamBrief } from "./teamBriefSchema.js";
import type { SwarmManager } from "./manager.js";
import type { SwarmWorkerMode } from "./schema.js";

export interface BriefAssignment {
  readonly brief: TeamBrief;
  readonly taskId: string;
}

/**
 * Validate and create a team brief from raw input. Returns the parsed brief
 * with the allowlist clamped (deduplicated and sorted).
 */
export function createBrief(raw: unknown): TeamBrief {
  const parsed = TeamBriefSchema.parse(raw);
  return {
    ...parsed,
    toolAllowlist: clampAllowlist(parsed.toolAllowlist),
  };
}

/**
 * Build a structured prompt from a team brief and spawn a specialist worker.
 * The resulting prompt encodes the goal, owned paths, tool allowlist, and
 * success checks so the specialist receives a full contract.
 */
export function assignWorker(
  manager: SwarmManager,
  brief: TeamBrief,
  mode: SwarmWorkerMode = "read-only",
  label?: string,
): BriefAssignment {
  const prompt = buildBriefPrompt(brief);
  const record = manager.spawn(prompt, mode, label);
  return { brief, taskId: record.id };
}

function buildBriefPrompt(brief: TeamBrief): string {
  const lines: string[] = [];
  lines.push("## Goal");
  lines.push(brief.goal);
  lines.push("");

  if (brief.ownedPaths.length > 0) {
    lines.push("## Owned Paths");
    for (const p of brief.ownedPaths) {
      lines.push(`- ${p}`);
    }
    lines.push("");
  }

  if (brief.toolAllowlist.length > 0) {
    lines.push("## Tools Allowlist");
    for (const t of brief.toolAllowlist) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  } else {
    lines.push("## Tools Allowlist");
    lines.push("(none — no tool access granted)");
    lines.push("");
  }

  if (brief.successChecks.length > 0) {
    lines.push("## Success Checks");
    for (let i = 0; i < brief.successChecks.length; i++) {
      lines.push(`${i + 1}. ${brief.successChecks[i]}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}