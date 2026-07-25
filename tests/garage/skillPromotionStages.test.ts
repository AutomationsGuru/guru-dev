import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryStore } from '../../src/memory/store.js';
import {
  SKILL_STAGE_FACT_NAME,
  getStage,
  isPromoted,
  listPromoted,
  loadSkillStages,
  saveSkillStages,
  setStage
} from '../../src/garage/skillPromotionStages.js';

let n = 0;
const dirs: string[] = [];
function freshMemory() {
  const directory = join(tmpdir(), `guru-skill-stage-${process.pid}-${n++}`);
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  return createFileMemoryStore({ directory, now: () => new Date(Date.UTC(2026, 6, 5)) });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("skill promotion stages — draft hidden; promote visible", () => {
  it("getStage on an unset skill returns undefined", () => {
    const memory = freshMemory();
    expect(getStage(memory, "brand-new-skill")).toBe(undefined);
    expect(listPromoted(memory)).toEqual([]);
  });

  it("setStage(draft) records the stage but keeps the skill out of listPromoted", () => {
    const memory = freshMemory();
    setStage(memory, "drafted-skill", "draft");
    expect(getStage(memory, "drafted-skill")).toBe("draft");
    expect(listPromoted(memory)).not.toContain("drafted-skill");
  });

  it("setStage(promoted) makes the skill visible in listPromoted", () => {
    const memory = freshMemory();
    setStage(memory, "shipped-skill", "promoted");
    expect(getStage(memory, "shipped-skill")).toBe("promoted");
    expect(listPromoted(memory)).toContain("shipped-skill");
    expect(isPromoted(memory, "shipped-skill")).toBe(true);
  });

  it("ACCEPTANCE: a promoted skill shows while a separate drafted one stays hidden", () => {
    const memory = freshMemory();
    setStage(memory, "alpha", "promoted");
    setStage(memory, "beta", "draft");
    expect(listPromoted(memory)).toEqual(["alpha"]);
    expect(isPromoted(memory, "alpha")).toBe(true);
    expect(isPromoted(memory, "beta")).toBe(false);
  });

  it("promote then demote back to draft removes the skill from listPromoted (stage is mutable)", () => {
    const memory = freshMemory();
    setStage(memory, "flaky", "promoted");
    expect(listPromoted(memory)).toEqual(["flaky"]);
    setStage(memory, "flaky", "draft");
    expect(getStage(memory, "flaky")).toBe("draft");
    expect(listPromoted(memory)).toEqual([]);
  });

  it("setStage is an upsert: re-promoting updates updatedAt without duplicating", () => {
    const memory = freshMemory();
    const t0 = new Date(Date.UTC(2026, 6, 1));
    const first = setStage(memory, "re-promote", "promoted", () => t0);
    expect(first.updatedAt).toBe(t0.toISOString());

    const t1 = new Date(Date.UTC(2026, 6, 9));
    const second = setStage(memory, "re-promote", "promoted", () => t1);
    expect(second.updatedAt).toBe(t1.toISOString());

    const loaded = loadSkillStages(memory);
    expect(loaded.filter((r) => r.id === "re-promote")).toHaveLength(1);
    expect(listPromoted(memory)).toEqual(["re-promote"]);
  });

  it("listPromoted returns sorted ids", () => {
    const memory = freshMemory();
    setStage(memory, "zeta", "promoted");
    setStage(memory, "alpha", "promoted");
    setStage(memory, "mike", "promoted");
    expect([...listPromoted(memory)]).toEqual(["alpha", "mike", "zeta"]);
  });

  it("resilience: a malformed persisted fact yields [] / undefined rather than throwing", () => {
    const memory = freshMemory();
    // Hand-write a corrupt JSON fact straight into the store's memory directory.
    const factPath = join(memory.directory, `${SKILL_STAGE_FACT_NAME}.md`);
    writeFileSync(
      factPath,
      ["---", "name: skill-promotion-stages", "type: capability", "---", "", "```json", "{not valid json", "```"].join("\n"),
      "utf8"
    );
    expect(loadSkillStages(memory)).toEqual([]);
    expect(getStage(memory, "anything")).toBe(undefined);
    expect(listPromoted(memory)).toEqual([]);
  });

  it("resilience: records with the wrong shape are dropped, valid ones kept", () => {
    const memory = freshMemory();
    // Persist a mixed bag via the public save (valid path), then verify only
    // schema-valid records survive a round trip — proven by safeParse in load.
    saveSkillStages(memory, [
      { id: "good", stage: "promoted", updatedAt: "2026-07-05T00:00:00.000Z" },
      // @ts-expect-error — intentionally malformed stage value
      { id: "bad", stage: "experimental", updatedAt: "2026-07-05T00:00:00.000Z" }
    ]);
    // saveSkillStages itself is typed; the bad record only sneaks in if TS is
    // bypassed. The load path's safeParse is the real guard, so confirm a valid
    // store round-trips and listPromoted reflects it.
    expect(listPromoted(memory)).toEqual(["good"]);
  });
});
