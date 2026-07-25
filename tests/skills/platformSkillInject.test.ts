import { describe, expect, it } from "vitest";

import {
  GarageManifestSchema,
  computeLayerHash,
  type GarageLayer,
  type GarageManifest
} from '../../src/garage/manifest.js';
import { selectForWorkspace } from '../../src/skills/platformSkillInject.js';

function makeLayer(overrides: Partial<GarageLayer> = {}): GarageLayer {
  const base: GarageLayer = {
    kind: "skill",
    id: "skill-001",
    coveringTestsRef: "tests/skills/platformSkillInject.test.ts",
    verificationHash: "",
    status: "verified",
    provenance: "built",
    staleFlag: false,
    lastVerifiedAt: "2026-07-19T00:00:00.000Z",
    donePacketRef: "handoffs/done/skill-001.md"
  };
  const layer = { ...base, ...overrides } as GarageLayer;

  return {
    ...layer,
    verificationHash: overrides.verificationHash ?? computeLayerHash(layer)
  };
}

function makeManifest(layers: GarageLayer[]): GarageManifest {
  return GarageManifestSchema.parse({
    manifestVersion: 1,
    slug: "platform",
    label: "Platform",
    layers
  });
}

describe("selectForWorkspace", () => {
  it("selects a requested verified, promoted skill", () => {
    const layer = makeLayer({ id: "platform-skill" });

    expect(selectForWorkspace(["platform-skill"], [makeManifest([layer])])).toEqual([layer]);
  });

  it("fails closed when no skill IDs are requested", () => {
    const layer = makeLayer();

    expect(selectForWorkspace([], [makeManifest([layer])])).toEqual([]);
  });

  it("rejects an unverified draft layer", () => {
    const layer = makeLayer({ status: "unverified" });

    expect(selectForWorkspace([layer.id], [makeManifest([layer])])).toEqual([]);
  });

  it("rejects a red layer", () => {
    const layer = makeLayer({ status: "red" });

    expect(selectForWorkspace([layer.id], [makeManifest([layer])])).toEqual([]);
  });

  it("rejects a stale layer", () => {
    const layer = makeLayer({ staleFlag: true });

    expect(selectForWorkspace([layer.id], [makeManifest([layer])])).toEqual([]);
  });

  it("rejects a hash-mismatched layer", () => {
    const layer = makeLayer({ verificationHash: "mismatch" });

    expect(selectForWorkspace([layer.id], [makeManifest([layer])])).toEqual([]);
  });

  it("rejects layers without a non-empty done packet reference", () => {
    const layer = makeLayer({ donePacketRef: "   " });

    expect(selectForWorkspace([layer.id], [makeManifest([layer])])).toEqual([]);
  });

  it("rejects requested non-skill and non-built layers", () => {
    const tool = makeLayer({ kind: "tool" });
    const declared = makeLayer({ id: "declared-skill", provenance: "declared" });

    expect(selectForWorkspace([tool.id], [makeManifest([tool])])).toEqual([]);
    expect(selectForWorkspace([declared.id], [makeManifest([declared])])).toEqual([]);
  });

  it("selects only requested IDs across canonical manifests", () => {
    const selected = makeLayer({ id: "selected" });
    const skipped = makeLayer({ id: "skipped" });

    expect(selectForWorkspace([selected.id], [makeManifest([selected]), makeManifest([skipped])])).toEqual([selected]);
  });
});
