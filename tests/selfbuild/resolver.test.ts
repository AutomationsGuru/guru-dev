import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCapabilityGap, type ResolverContext } from "../../src/selfbuild/resolver.js";
import { proposeEvidenceTasks, proposeFromParityManifest, proposeFromGarage } from "../../src/selfbuild/evidence.js";
import { createFileMemoryStore } from "../../src/memory/store.js";
import { recordPathOutcome } from "../../src/roles/store.js";

function makeContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    registeredToolIds: new Set(["read", "bash", "edit", "write", "memory_search"]),
    toolSummaries: new Map([
      ["read", "Read a file. Reads file contents from the repository"],
      ["bash", "Run a shell command. Executes commands via the gated shell"],
      ["memory_search", "Search memory. Term-overlap search over the memory index"]
    ]),
    commandExists: () => false,
    ...overrides
  };
}

describe("never-stuck resolver — the trichotomy (THERE scenario 4 core)", () => {
  it("already-have: a registered tool covering the need is not a gap", () => {
    const resolution = resolveCapabilityGap({ need: "search memory index", candidateCommands: [], referencePrograms: [] }, makeContext());
    expect(resolution.move).toBe("already-have");
    expect(resolution.statement).toContain("memory_search");
  });

  it("already-have: garage-verified capability counts", () => {
    const resolution = resolveCapabilityGap(
      { need: "render dashboards for finance reporting", candidateCommands: [], referencePrograms: [] },
      makeContext({ garageCapabilities: ["finance: dashboards reporting renderer"] })
    );
    expect(resolution.move).toBe("already-have");
    expect(resolution.workPlan.join(" ")).toContain("/role");
  });

  it("ATTACH: a capable command on PATH wins, stated with evidence + parity tracking", () => {
    const resolution = resolveCapabilityGap(
      { need: "fetch a web page over http", candidateCommands: ["curl", "wget"], referencePrograms: [] },
      makeContext({ commandExists: (command) => command === "curl" })
    );
    expect(resolution.move).toBe("attach");
    expect(resolution.statement).toContain("ATTACH");
    expect(resolution.statement).toContain("curl");
    expect(resolution.evidence).toContain("PATH: curl present");
    expect(resolution.workPlan.join(" ")).toContain("parity"); // tracked as a gap to replace
  });

  it("attach requires the gated shell surface — without bash it falls through", () => {
    const resolution = resolveCapabilityGap(
      { need: "fetch a web page over http", candidateCommands: ["curl"], referencePrograms: ["web_fetch"] },
      makeContext({ registeredToolIds: new Set(["read"]), commandExists: () => true })
    );
    expect(resolution.move).toBe("learn-replicate");
  });

  it("LEARN-REPLICATE: a named reference program wins over building blind", () => {
    const resolution = resolveCapabilityGap(
      { need: "semantic vault search over markdown notes", candidateCommands: ["nonexistent-cli"], referencePrograms: ["Smart Connections"] },
      makeContext()
    );
    expect(resolution.move).toBe("learn-replicate");
    expect(resolution.statement).toContain("LEARN AND REPLICATE");
    expect(resolution.statement).toContain("Smart Connections");
    expect(resolution.evidence).toContain("PATH: nonexistent-cli absent");
    expect(resolution.workPlan.join(" ")).toContain("review"); // gated
  });

  it("BUILD: nothing nearby — guru grows it, gated", () => {
    const resolution = resolveCapabilityGap({ need: "translate morse code audio", candidateCommands: [], referencePrograms: [] }, makeContext());
    expect(resolution.move).toBe("build");
    expect(resolution.statement).toContain("BUILD");
    expect(resolution.workPlan.join(" ")).toContain("extension host");
    expect(resolution.workPlan.join(" ")).toContain("Done Packet");
  });

  it("every resolution STATES its move — never silent", () => {
    for (const gap of [
      { need: "search memory index", candidateCommands: [], referencePrograms: [] },
      { need: "fetch a web page", candidateCommands: ["curl"], referencePrograms: [] },
      { need: "novel capability xyz", candidateCommands: [], referencePrograms: [] }
    ]) {
      const resolution = resolveCapabilityGap(gap, makeContext({ commandExists: () => gap.candidateCommands.length > 0 }));
      expect(resolution.statement.length).toBeGreaterThan(20);
      expect(resolution.reasons.length).toBeGreaterThan(0);
      expect(resolution.workPlan.length).toBeGreaterThan(0);
    }
  });
});

describe("evidence-driven proposals (THERE scenario 7 substrate)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parity proposals only surface rows that are actually absent/partial", () => {
    const proposals = proposeFromParityManifest(50);
    expect(proposals.length).toBeGreaterThan(0);
    // The 2026-07-04 evidence-driven correction: honcho rows are GREEN now and
    // must NOT be proposed (the engine caught its own stale self-model).
    expect(proposals.some((proposal) => proposal.id.includes("honcho"))).toBe(false);
    for (const proposal of proposals) {
      expect(proposal.evidence.length).toBeGreaterThan(0);
      expect(proposal.source).toBe("parity-manifest");
      expect(proposal.status).toBe("ready");
    }
  });

  it("garage proposals surface suits that work sessions without earning tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "guru-evidence-"));
    dirs.push(dir);
    const memory = createFileMemoryStore({ directory: dir });
    recordPathOutcome(memory, "finance", { routeId: "test/m", turns: 4, toolsUsed: [] });
    const proposals = proposeFromGarage(memory);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.source).toBe("garage");
    expect(proposals[0]?.title).toContain("finance");
  });

  it("proposeEvidenceTasks merges sources and never throws on missing inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "guru-evidence-"));
    dirs.push(dir);
    const proposals = proposeEvidenceTasks({ repoRoot: dir }); // no matrix file, no memory
    expect(proposals.length).toBeGreaterThan(0); // parity manifest always contributes
    expect(proposals.every((proposal) => proposal.id.startsWith("evidence-"))).toBe(true);
  });
});
