import { readFileSync, writeFileSync } from "node:fs";

import { makeGapRecord } from "../garage/gapRecords.js";
import type { GapRecord } from "../garage/manifest.js";
import type { SkillCatalog, SkillManifest } from "./schemas.js";

/**
 * Bridge skills (Bridge Loading wave, ADR 2026-07-05-bridge-skills, THERE v2
 * §14/§16 — the final v1.0-bar predicate: "skills multi-root + bridge loading").
 *
 * A bridge skill (`type: bridge` in its SKILL.md frontmatter) is an ATTACH-class
 * capability borrowed from another harness. The constitution (§S4) is
 * strict: an ATTACH WITHOUT a trigger is a DEPEND, and DEPEND is forbidden — so a
 * bridge skill must ride a tracked parity gap, never a silent dependency. This
 * module turns each bridge skill into a gap record (move: attach) and provides the
 * `/skills promote` path that graduates a bridge to native (dropping the `type`
 * and closing its gap).
 */

/** The bridge skills in a catalog (kind === "bridge"), id-sorted as the catalog is. */
export function bridgeManifests(catalog: SkillCatalog): SkillManifest[] {
  return catalog.skills.filter((skill) => skill.kind === "bridge");
}

/** A short " [bridge]" badge for a manifest (empty for native skills). */
export function bridgeBadge(skill: SkillManifest): string {
  return skill.kind === "bridge" ? " [bridge]" : "";
}

/** The capability string a bridge skill's gap tracks — deterministic per skill id. */
export function bridgeNeed(skill: SkillManifest): string {
  return `skill ${skill.id} (bridge${skill.bridges ? ` via ${skill.bridges}` : ""})`;
}

/** The gap record for one bridge skill — an ATTACH with a trigger, never a DEPEND. */
export function bridgeGapRecordFor(skill: SkillManifest, createdAt: string): GapRecord {
  const note = `Bridge skill "${skill.name}" (${skill.id})${skill.bridges ? ` borrowed via ${skill.bridges}` : ""} — ATTACH-tracked parity gap; /skills promote ${skill.id} graduates it to native.`;
  return makeGapRecord(bridgeNeed(skill), "attach", note, createdAt);
}

/** Gap records for every bridge skill in the catalog (empty when none are bridges). */
export function bridgeGapRecords(catalog: SkillCatalog, createdAt: string): GapRecord[] {
  return bridgeManifests(catalog).map((skill) => bridgeGapRecordFor(skill, createdAt));
}

/** The deterministic gap-record id for a bridge skill (so promote can close it). */
export function bridgeGapId(skill: SkillManifest): string {
  return bridgeGapRecordFor(skill, "1970-01-01T00:00:00.000Z").id;
}

export interface PromoteResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Graduate a bridge skill to native by rewriting its SKILL.md frontmatter `type`
 * value from `bridge` to `native` (in place, preserving everything else). Returns
 * ok:false when the file has no frontmatter `type` line to rewrite.
 */
export function promoteBridgeSkillFile(skillFile: string): PromoteResult {
  let content: string;
  try {
    content = readFileSync(skillFile, "utf8");
  } catch (error) {
    return { ok: false, reason: `could not read ${skillFile}: ${(error as Error).message}` };
  }
  if (!content.startsWith("---")) {
    return { ok: false, reason: "skill file has no frontmatter block" };
  }
  const lines = content.split(/\r?\n/u);
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex < 0) {
    return { ok: false, reason: "skill file frontmatter is not closed" };
  }
  let rewrote = false;
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index] ?? "";
    const match = /^(\s*type\s*:\s*)(.*)$/u.exec(line);
    if (match && match[2]?.trim().replace(/^['"]|['"]$/gu, "") === "bridge") {
      lines[index] = `${match[1]}native`;
      rewrote = true;
      break;
    }
  }
  if (!rewrote) {
    return { ok: false, reason: "no `type: bridge` line found in frontmatter" };
  }
  // Preserve the file's newline style (CRLF vs LF).
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  try {
    writeFileSync(skillFile, lines.join(eol), "utf8");
  } catch (error) {
    return { ok: false, reason: `could not write ${skillFile}: ${(error as Error).message}` };
  }
  return { ok: true };
}
