import { describe, expect, it } from "vitest";

import {
  GARAGE_MANIFEST_VERSION,
  GarageManifestSchema,
  computeLayerHash,
  manifestToRoleProfile,
  partitionParkableLayers,
  reverifyForLoad,
  roleProfileToManifest,
  type GarageLayer,
  type GarageManifest
} from "../../src/garage/manifest.js";
import { RoleProfileSchema, type RoleProfile } from "../../src/roles/schema.js";

const FIXED = () => new Date(Date.UTC(2026, 6, 5, 0, 0, 0));

const profile: RoleProfile = RoleProfileSchema.parse({
  slug: "finance",
  label: "Finance",
  capabilityMode: "all",
  tools: ["read", "operational.state.write", "git.pr.run"],
  skills: ["reconcile"],
  extensions: ["ledger"],
  mcpServers: ["supabase"],
  modelPreference: { requires: ["chat", "tools"] },
  verifiedTools: ["git.pr.run"],
  wornCount: 3,
  notes: "keep it tidy"
});

function layer(over: Partial<GarageLayer> & { kind: GarageLayer["kind"]; id: string }): GarageLayer {
  const base = {
    coveringTestsRef: "presence",
    status: "verified" as const,
    provenance: "observed" as const,
    staleFlag: false,
    lastVerifiedAt: FIXED().toISOString(),
    donePacketRef: ""
  };
  const merged = { ...base, ...over } as GarageLayer;
  return { ...merged, verificationHash: over.verificationHash ?? computeLayerHash(merged) };
}

describe("roleProfileToManifest / manifestToRoleProfile", () => {
  it("migrates the flat profile into typed layers, verifiedTools → verified/observed", () => {
    const manifest = roleProfileToManifest(profile, FIXED);
    expect(manifest.manifestVersion).toBe(GARAGE_MANIFEST_VERSION);
    // Floor tool "read" is not enumerated as a layer.
    expect(manifest.layers.find((l) => l.id === "read")).toBeUndefined();
    const gitLayer = manifest.layers.find((l) => l.id === "git.pr.run");
    expect(gitLayer).toMatchObject({ kind: "tool", status: "verified", provenance: "observed" });
    const opLayer = manifest.layers.find((l) => l.id === "operational.state.write");
    expect(opLayer).toMatchObject({ kind: "tool", status: "unverified", provenance: "declared" });
    expect(manifest.layers.find((l) => l.id === "reconcile")?.kind).toBe("skill");
    expect(manifest.layers.find((l) => l.id === "ledger")?.kind).toBe("extension");
    expect(manifest.layers.find((l) => l.id === "supabase")?.kind).toBe("provider");
  });

  it("round-trips back to a RoleProfile (verified tool → verifiedTools; red dropped)", () => {
    const manifest = roleProfileToManifest(profile, FIXED);
    const back = manifestToRoleProfile(manifest);
    expect(back.verifiedTools).toContain("git.pr.run");
    expect(back.tools).toContain("operational.state.write");
    expect(back.skills).toEqual(["reconcile"]);
    expect(back.mcpServers).toEqual(["supabase"]);
    // A red layer is never offered.
    const withRed: GarageManifest = { ...manifest, layers: [...manifest.layers, layer({ kind: "tool", id: "danger", status: "red" })] };
    expect(manifestToRoleProfile(withRed).tools).not.toContain("danger");
    expect(manifestToRoleProfile(withRed).verifiedTools).not.toContain("danger");
  });
});

describe("computeLayerHash", () => {
  it("is deterministic and identity-sensitive", () => {
    const a = computeLayerHash({ kind: "tool", id: "x", coveringTestsRef: "presence" });
    expect(a).toBe(computeLayerHash({ kind: "tool", id: "x", coveringTestsRef: "presence" }));
    expect(a).not.toBe(computeLayerHash({ kind: "tool", id: "y", coveringTestsRef: "presence" }));
  });
});

describe("partitionParkableLayers (verified-only precondition, Article 5)", () => {
  it("rejects a BUILT layer with no done packet; parks observed + built-with-packet", () => {
    const layers: GarageLayer[] = [
      layer({ kind: "tool", id: "observed-ok", provenance: "observed" }),
      layer({ kind: "tool", id: "built-ungated", provenance: "built", donePacketRef: "" }),
      layer({ kind: "tool", id: "built-gated", provenance: "built", donePacketRef: "packet://abc" })
    ];
    const { parkable, rejected } = partitionParkableLayers(layers);
    expect(parkable.map((l) => l.id).sort()).toEqual(["built-gated", "observed-ok"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.layer.id).toBe("built-ungated");
  });
});

describe("reverifyForLoad (re-verify-before-load, §8)", () => {
  const deps = (verifyLayer: (l: GarageLayer) => boolean, now = FIXED) => ({ now, staleAfterDays: 14, verifyLayer });

  it("a clean verified fresh suit loads on the ungated FAST PATH (no re-verify)", () => {
    const manifest = GarageManifestSchema.parse({
      manifestVersion: 1,
      slug: "suit",
      label: "S",
      layers: [layer({ kind: "tool", id: "a" }), layer({ kind: "skill", id: "b" })]
    });
    const result = reverifyForLoad(manifest, deps(() => true));
    expect(result.fastPath).toBe(true);
    expect(result.reverified).toBe(0);
    expect(result.loaded).toBe(2);
  });

  it("a stale layer re-verifies; a failing probe marks it RED and skips it", () => {
    const stale = layer({ kind: "tool", id: "old", lastVerifiedAt: new Date(Date.UTC(2026, 5, 1)).toISOString() });
    const manifest = GarageManifestSchema.parse({ manifestVersion: 1, slug: "suit", label: "S", layers: [stale] });
    const pass = reverifyForLoad(manifest, deps(() => true));
    expect(pass.fastPath).toBe(false);
    expect(pass.reverified).toBe(1);
    expect(pass.manifest.layers[0]?.status).toBe("verified");

    const fail = reverifyForLoad(manifest, deps(() => false));
    expect(fail.skippedRed.map((l) => l.id)).toEqual(["old"]);
    expect(fail.manifest.layers[0]?.status).toBe("red");
    expect(fail.loaded).toBe(0);
  });

  it("a hash-mismatched (tampered) layer re-verifies even if marked verified+fresh", () => {
    const tampered = layer({ kind: "tool", id: "t", verificationHash: "deadbeef" });
    const manifest = GarageManifestSchema.parse({ manifestVersion: 1, slug: "suit", label: "S", layers: [tampered] });
    let probed = false;
    reverifyForLoad(manifest, deps(() => { probed = true; return true; }));
    expect(probed).toBe(true);
  });

  it("an unverified layer always re-verifies", () => {
    const fresh = layer({ kind: "tool", id: "u", status: "unverified" });
    const manifest = GarageManifestSchema.parse({ manifestVersion: 1, slug: "suit", label: "S", layers: [fresh] });
    const result = reverifyForLoad(manifest, deps(() => true));
    expect(result.reverified).toBe(1);
  });
});
