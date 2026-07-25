import { describe, expect, it } from "vitest";

import { mergeTeamSteering, type SteeringEntry, type SteeringLayer } from '../../src/context/teamSteeringMerge.js';

function layer(scope: SteeringLayer["scope"], entries: SteeringEntry[]): SteeringLayer {
  return { scope, entries };
}

function entry(key: string, content: string): SteeringEntry {
  return { key, content };
}

describe("mergeTeamSteering — team → global → workspace merge", () => {
  it("returns [] when layers is undefined", () => {
    expect(mergeTeamSteering(undefined)).toEqual([]);
  });

  it("returns [] when every layer is missing", () => {
    expect(mergeTeamSteering([])).toEqual([]);
  });

  it("returns [] when every present layer has zero entries", () => {
    const layers = [
      layer("team", []),
      layer("global", []),
      layer("workspace", [])
    ];
    expect(mergeTeamSteering(layers)).toEqual([]);
  });

  it("passes through a single team layer with no conflicts", () => {
    const entries = [entry("a", "1"), entry("b", "2"), entry("c", "3")];
    expect(mergeTeamSteering([layer("team", entries)])).toEqual(entries);
  });

  it("workspace overrides global on a shared key (winning value at first-seen position)", () => {
    const result = mergeTeamSteering([
      layer("global", [entry("a", "g")]),
      layer("workspace", [entry("a", "w")])
    ]);
    expect(result).toEqual([entry("a", "w")]);
    expect(result).toHaveLength(1);
  });

  it("global overrides team on a shared key (winning value at first-seen position)", () => {
    const result = mergeTeamSteering([
      layer("team", [entry("a", "t")]),
      layer("global", [entry("a", "g")])
    ]);
    expect(result).toEqual([entry("a", "g")]);
  });

  it("workspace overrides both: a key present in all three layers resolves to workspace", () => {
    const result = mergeTeamSteering([
      layer("team", [entry("a", "t")]),
      layer("global", [entry("a", "g")]),
      layer("workspace", [entry("a", "w")])
    ]);
    expect(result).toEqual([entry("a", "w")]);
  });

  it("order is stable: conflict key stays at its first-seen position, not the winning layer's position", () => {
    const result = mergeTeamSteering([
      layer("team", [entry("a", "t"), entry("b", "t")]),
      layer("global", [entry("c", "g"), entry("a", "g")])
    ]);
    expect(result.map((e: SteeringEntry) => e.key)).toEqual(["a", "b", "c"]);
    expect(result[0]).toEqual(entry("a", "g"));
  });

  it("non-conflicting entries from all three layers all appear in first-seen order", () => {
    const result = mergeTeamSteering([
      layer("team", [entry("a", "t")]),
      layer("global", [entry("b", "g")]),
      layer("workspace", [entry("c", "w")])
    ]);
    expect(result).toEqual([entry("a", "t"), entry("b", "g"), entry("c", "w")]);
  });

  it("order survives layers given out of priority order", () => {
    const inPriority = mergeTeamSteering([
      layer("team", [entry("a", "t")]),
      layer("global", [entry("a", "g")]),
      layer("workspace", [entry("a", "w")])
    ]);
    const reversed = mergeTeamSteering([
      layer("workspace", [entry("a", "w")]),
      layer("team", [entry("a", "t")]),
      layer("global", [entry("a", "g")])
    ]);
    expect(reversed).toEqual(inPriority);
  });

  it("duplicate keys within a single layer collapse to the LAST occurrence", () => {
    const result = mergeTeamSteering([
      layer("team", [entry("a", "1"), entry("a", "2"), entry("b", "3")])
    ]);
    expect(result).toEqual([entry("a", "2"), entry("b", "3")]);
    expect(result[0]).toEqual(entry("a", "2"));
  });

  it("intra-layer duplicate + cross-layer override compose", () => {
    const result = mergeTeamSteering([
      layer("team", [entry("a", "t1"), entry("a", "t2")]),
      layer("workspace", [entry("a", "w")])
    ]);
    expect(result).toEqual([entry("a", "w")]);
  });

  it("empty content string is a valid winning entry", () => {
    const result = mergeTeamSteering([
      layer("global", [entry("a", "nonempty")]),
      layer("workspace", [entry("a", "")])
    ]);
    expect(result).toEqual([entry("a", "")]);
  });

  it("duplicate scope occurrence: only the FIRST layer of a given scope is used", () => {
    const result = mergeTeamSteering([
      layer("team", [entry("a", "first")]),
      layer("team", [entry("a", "second")])
    ]);
    expect(result).toEqual([entry("a", "first")]);
  });

  it("some-empty layers (entries:[] between non-empty) do not disturb order or overrides", () => {
    const result = mergeTeamSteering([
      layer("team", [entry("a", "t"), entry("b", "t")]),
      layer("global", []),
      layer("workspace", [entry("a", "w")])
    ]);
    expect(result).toEqual([entry("a", "w"), entry("b", "t")]);
  });

  it("returns a fresh array each call (deterministic + non-aliased)", () => {
    const layers = [
      layer("team", [entry("a", "1"), entry("b", "2")])
    ];
    const first = mergeTeamSteering(layers);
    const second = mergeTeamSteering(layers);
    expect(first).toEqual(second);
    first.push(entry("zzz", "mutated"));
    expect(second).toEqual([entry("a", "1"), entry("b", "2")]);
  });

  it("does not mutate input layers or their entries", () => {
    const layers = [
      layer("team", [entry("a", "t"), entry("b", "t")]),
      layer("global", [entry("a", "g")])
    ];
    const before = JSON.stringify(layers);
    mergeTeamSteering(layers);
    const after = JSON.stringify(layers);
    expect(after).toEqual(before);
  });
});
