import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryStore } from "../../src/memory/store.js";
import { listManifests, loadManifest, parkManifest } from "../../src/garage/store.js";
import { GarageManifestSchema, computeLayerHash, roleProfileToManifest, type GarageLayer, type GarageManifest } from "../../src/garage/manifest.js";
import { RoleProfileSchema } from "../../src/roles/schema.js";

let n = 0;
const dirs: string[] = [];
function freshMemory() {
  const directory = join(tmpdir(), `guru-garage-${process.pid}-${n++}`);
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  return createFileMemoryStore({ directory, now: () => new Date(Date.UTC(2026, 6, 5)) });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function toolLayer(id: string, over: Partial<GarageLayer> = {}): GarageLayer {
  const base = { kind: "tool" as const, id, coveringTestsRef: "presence", status: "verified" as const, provenance: "observed" as const, staleFlag: false, lastVerifiedAt: null, donePacketRef: "", ...over };
  return { ...base, verificationHash: computeLayerHash(base) } as GarageLayer;
}

const manifest = (over: Partial<GarageManifest> = {}): GarageManifest =>
  GarageManifestSchema.parse({ manifestVersion: 1, slug: "finance", label: "Finance", layers: [toolLayer("git.pr.run")], wornCount: 1, ...over });

describe("parkManifest / loadManifest", () => {
  it("ACCEPTANCE: parks a typed manifest and loads it back", () => {
    const memory = freshMemory();
    const receipt = parkManifest(memory, manifest());
    expect(receipt.status).toBe("parked");
    expect(receipt.stored).toBe(1);
    const loaded = loadManifest(memory, "finance");
    expect(loaded?.layers[0]?.id).toBe("git.pr.run");
    expect(loaded?.manifestVersion).toBe(1);
  });

  it("verified-only receipt: a BUILT layer with no done packet is rejected, not stored", () => {
    const memory = freshMemory();
    const receipt = parkManifest(
      memory,
      manifest({ layers: [toolLayer("observed-ok"), toolLayer("built-ungated", { provenance: "built", donePacketRef: "" })] })
    );
    expect(receipt.rejected).toBe(1);
    expect(receipt.stored).toBe(1);
    expect(receipt.rejectedLayers[0]?.id).toBe("built-ungated");
    // The rejected layer never reached disk.
    expect(loadManifest(memory, "finance")?.layers.map((l) => l.id)).toEqual(["observed-ok"]);
  });

  it("receipt carries the verification tally + gap count", () => {
    const memory = freshMemory();
    const receipt = parkManifest(memory, manifest({ layers: [toolLayer("a"), toolLayer("b", { status: "unverified" })] }));
    expect(receipt.verificationStatus).toBe("1 verified / 1 unverified / 0 red");
  });

  it("two-phase commit: a validation failure throws BEFORE any write — the prior manifest is intact", () => {
    const memory = freshMemory();
    parkManifest(memory, manifest({ label: "Good" }));
    // A manifest that fails schema validation (empty slug) must not overwrite.
    const bad = { ...manifest(), slug: "" } as unknown as GarageManifest;
    expect(() => parkManifest(memory, bad)).toThrow();
    expect(loadManifest(memory, "finance")?.label).toBe("Good");
  });

  it("re-parking the same slug replaces in place (edit:replace), not duplicate", () => {
    const memory = freshMemory();
    parkManifest(memory, manifest({ wornCount: 1 }));
    parkManifest(memory, manifest({ wornCount: 5 }));
    expect(listManifests(memory).filter((m) => m.slug === "finance")).toHaveLength(1);
    expect(loadManifest(memory, "finance")?.wornCount).toBe(5);
  });
});

describe("back-compat: legacy flat RoleProfile facts still load", () => {
  it("a role- loadout fact holding RoleProfile JSON loads as a manifest", () => {
    const memory = freshMemory();
    const legacy = RoleProfileSchema.parse({ slug: "legacy", label: "Legacy suit", tools: ["git.pr.run"], verifiedTools: ["git.pr.run"], skills: ["s1"], wornCount: 2 });
    // Write it the OLD way: a loadout fact whose body carries the RoleProfile JSON.
    memory.remember({
      name: "role-legacy",
      title: "Suit: Legacy suit",
      description: "legacy",
      body: ["Old body", "", "```json", JSON.stringify(legacy, null, 2), "```"].join("\n"),
      type: "loadout",
      edit: "replace",
      confidence: 1
    });
    const loaded = loadManifest(memory, "legacy");
    expect(loaded?.manifestVersion).toBe(1);
    expect(loaded?.slug).toBe("legacy");
    expect(loaded?.layers.find((l) => l.id === "git.pr.run")?.status).toBe("verified");
    expect(loaded?.layers.find((l) => l.id === "s1")?.kind).toBe("skill");
    // And it appears in listManifests alongside native ones.
    expect(listManifests(memory).some((m) => m.slug === "legacy")).toBe(true);
  });

  it("roleProfileToManifest is the same conversion the loader uses", () => {
    const legacy = RoleProfileSchema.parse({ slug: "xyz", label: "X", tools: ["t"], verifiedTools: [] });
    expect(roleProfileToManifest(legacy).slug).toBe("xyz");
  });
});
