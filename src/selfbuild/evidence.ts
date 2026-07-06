import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TOOL_PARITY_ROWS } from "../tools/toolParity.js";
import type { SelfBuildTask } from "../kernel/selfBuildLoop.js";
import type { FileMemoryStore } from "../memory/store.js";

/**
 * Evidence-driven self-build proposals (Phase G): instead of only the static
 * parity roadmap, propose the next self-improvements from what the harness
 * actually KNOWS about itself —
 *   1. the tool-parity manifest (absent/partial rows),
 *   2. the live capability matrix (probed fail/unclear routes),
 *   3. the garage's path-outcome facts (what suits keep reaching for).
 * Proposals are TASKS with evidence attached; execution stays behind the full
 * constitution (no unattended self-improvement, ever).
 */

export interface EvidenceProposal extends SelfBuildTask {
  readonly evidence: readonly string[];
  readonly source: "parity-manifest" | "capability-matrix" | "garage";
}

export function proposeFromParityManifest(limit = 5): readonly EvidenceProposal[] {
  return TOOL_PARITY_ROWS.filter((row) => row.status === "absent" || row.status === "partial-equivalent")
    .slice(0, limit)
    .map((row) => ({
      id: `evidence-parity-${row.toolId.replace(/[^a-z0-9]+/giu, "-").toLowerCase()}`,
      title: `Close parity gap: ${row.toolId}`,
      description: row.nextAction,
      thereContribution: `tool-parity: ${row.toolId} (${row.category}) — ${row.notes}`,
      priority: "next" as const,
      status: "ready" as const,
      dependsOn: [],
      evidence: [`parity manifest: status=${row.status}`, `owner: ${row.ownerModule}`, `requirements: ${row.requirementIds.join(", ")}`],
      source: "parity-manifest" as const
    }));
}

export function proposeFromCapabilityMatrix(repoRoot: string, limit = 5): readonly EvidenceProposal[] {
  const matrixPath = join(repoRoot, "docs", "coordination", "model-capabilities.json");
  if (!existsSync(matrixPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(matrixPath, "utf8")) as Record<string, { routeId?: string; chat?: { verdict?: string; evidence?: string } }>;
    const failing = Object.values(parsed).filter(
      (row) => row && typeof row === "object" && row.routeId && row.chat?.verdict === "fail"
    );
    return failing.slice(0, limit).map((row) => ({
      id: `evidence-matrix-${(row.routeId ?? "").replace(/[^a-z0-9]+/giu, "-").toLowerCase()}`,
      title: `Fix failing lane: ${row.routeId}`,
      description: `Probe evidence: ${(row.chat?.evidence ?? "").slice(0, 160)}`,
      thereContribution: "THERE §5: every catalog lane a live turn can use",
      priority: "next" as const,
      status: "ready" as const,
      dependsOn: [],
      evidence: [`capability matrix: chat=fail`, (row.chat?.evidence ?? "").slice(0, 200)],
      source: "capability-matrix" as const
    }));
  } catch {
    return [];
  }
}

export function proposeFromGarage(memory: FileMemoryStore, limit = 3): readonly EvidenceProposal[] {
  const proposals: EvidenceProposal[] = [];
  for (const entry of memory.list()) {
    if (entry.fact.type !== "path-outcome" || proposals.length >= limit) {
      continue;
    }
    // A suit that keeps working with zero earned tools is reaching for capability
    // it doesn't have — surface it as a look-here signal.
    if (/tools: none/u.test(entry.body)) {
      proposals.push({
        id: `evidence-garage-${entry.fact.name}`,
        title: `Garage signal: ${entry.fact.name} sessions earn no tools`,
        description: `The suit behind ${entry.fact.name} works sessions without earning verified tools — check what capability it actually needs.`,
        thereContribution: "THERE §9: the garage learns which paths win per suit",
        priority: "later" as const,
        status: "ready" as const,
        dependsOn: [],
        evidence: [`garage fact: ${entry.fact.name}`, `sessions recorded: ${entry.body.split("\n").length}`],
        source: "garage" as const
      });
    }
  }
  return proposals;
}

export function proposeEvidenceTasks(options: { repoRoot: string; memory?: FileMemoryStore }): readonly EvidenceProposal[] {
  return [
    ...proposeFromParityManifest(),
    ...proposeFromCapabilityMatrix(options.repoRoot),
    ...(options.memory ? proposeFromGarage(options.memory) : [])
  ];
}
