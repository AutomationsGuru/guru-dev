import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverSkills } from "../../src/skills/loader.js";
import {
  bridgeBadge,
  bridgeGapId,
  bridgeGapRecordFor,
  bridgeGapRecords,
  bridgeManifests,
  promoteBridgeSkillFile
} from "../../src/skills/bridge.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skills tree with one native + one bridge skill (type: bridge, bridges: pi). */
function skillTree(): string {
  const root = mkdtempSync(join(tmpdir(), "guru-bridge-"));
  tempDirs.push(root);
  const nativeDir = join(root, "skills", "native-one");
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(nativeDir, "SKILL.md"), "---\nname: native-one\ndescription: A native skill.\n---\n# Native One\n");
  const bridgeDir = join(root, "skills", "pi-recon");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "SKILL.md"), "---\nname: pi-recon\ndescription: Reconciliation borrowed from Pi.\ntype: bridge\nbridges: pi\n---\n# Pi Recon\n");
  return root;
}

describe("bridge skills — loader + kind (§14/§16)", () => {
  it("parses `type: bridge` + `bridges:` into first-class manifest fields; native defaults", () => {
    const catalog = discoverSkills({ directories: ["skills"], cwd: skillTree() });
    const native = catalog.skills.find((s) => s.id === "native-one");
    const bridge = catalog.skills.find((s) => s.id === "pi-recon");
    expect(native?.kind).toBe("native");
    expect(bridge?.kind).toBe("bridge");
    expect(bridge?.bridges).toBe("pi");
  });

  it("bridgeManifests filters to bridges; bridgeBadge tags only them", () => {
    const catalog = discoverSkills({ directories: ["skills"], cwd: skillTree() });
    expect(bridgeManifests(catalog).map((s) => s.id)).toEqual(["pi-recon"]);
    const bridge = catalog.skills.find((s) => s.id === "pi-recon")!;
    const native = catalog.skills.find((s) => s.id === "native-one")!;
    expect(bridgeBadge(bridge)).toBe(" [bridge]");
    expect(bridgeBadge(native)).toBe("");
  });
});

describe("bridge skills — ATTACH gap tracking (§S4: ATTACH must have a trigger, never DEPEND)", () => {
  it("a bridge skill becomes an ATTACH gap record with a trigger + a promote note", () => {
    const catalog = discoverSkills({ directories: ["skills"], cwd: skillTree() });
    const bridge = catalog.skills.find((s) => s.id === "pi-recon")!;
    const record = bridgeGapRecordFor(bridge, "2026-07-05T00:00:00.000Z");
    expect(record.move).toBe("attach");
    expect(record.trigger.length).toBeGreaterThan(0); // never a silent DEPEND
    expect(record.note).toContain("/skills promote pi-recon");
    expect(record.note).toContain("via pi");
  });

  it("bridgeGapRecords covers every bridge; bridgeGapId is deterministic + matches the record id", () => {
    const catalog = discoverSkills({ directories: ["skills"], cwd: skillTree() });
    const records = bridgeGapRecords(catalog, "2026-07-05T00:00:00.000Z");
    expect(records).toHaveLength(1);
    const bridge = catalog.skills.find((s) => s.id === "pi-recon")!;
    expect(bridgeGapId(bridge)).toBe(records[0]?.id); // promote can find the gap to close
  });
});

describe("bridge skills — /skills promote graduates to native", () => {
  it("rewrites `type: bridge` → `type: native` in place; re-discovery sees it native", () => {
    const root = skillTree();
    const skillFile = join(root, "skills", "pi-recon", "SKILL.md");
    const result = promoteBridgeSkillFile(skillFile);
    expect(result.ok).toBe(true);
    const rewritten = readFileSync(skillFile, "utf8");
    expect(rewritten).toContain("type: native");
    expect(rewritten).not.toContain("type: bridge");
    expect(rewritten).toContain("bridges: pi"); // other frontmatter preserved
    expect(rewritten).toContain("# Pi Recon"); // body preserved
    // The loader now classifies it native.
    const catalog = discoverSkills({ directories: ["skills"], cwd: root });
    expect(catalog.skills.find((s) => s.id === "pi-recon")?.kind).toBe("native");
    expect(bridgeManifests(catalog)).toHaveLength(0);
  });

  it("a file with no `type: bridge` line → ok:false (nothing to promote)", () => {
    const root = skillTree();
    const nativeFile = join(root, "skills", "native-one", "SKILL.md");
    expect(promoteBridgeSkillFile(nativeFile).ok).toBe(false);
  });
});
