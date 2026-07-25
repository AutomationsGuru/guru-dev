import {
  createTurnQualityRubric,
  type TurnQualityRubric
} from '../../src/planning/turnQualityRubric.js';

describe("turnQualityRubric", () => {
  it("starts with no active rubric", () => {
    const rubric = createTurnQualityRubric();

    expect(rubric.show()).toBeUndefined();
    expect(rubric.consumeForTurn()).toBeUndefined();
  });

  it("applies a sticky rubric to every turn until cleared", () => {
    const rubric = createTurnQualityRubric();
    rubric.setSticky(["Cite evidence for every claim.", "Keep diffs minimal."]);

    expect(rubric.consumeForTurn()).toEqual(["Cite evidence for every claim.", "Keep diffs minimal."]);
    expect(rubric.consumeForTurn()).toEqual(["Cite evidence for every claim.", "Keep diffs minimal."]);
    expect(rubric.show()).toEqual(["Cite evidence for every claim.", "Keep diffs minimal."]);
  });

  it("clears a next-turn rubric after it is consumed", () => {
    const rubric = createTurnQualityRubric();
    rubric.setNext(["Only answer the pending question."]);

    expect(rubric.consumeForTurn()).toEqual(["Only answer the pending question."]);
    expect(rubric.consumeForTurn()).toBeUndefined();
    expect(rubric.show()).toBeUndefined();
  });

  it("prefers the next-turn rubric over sticky for one turn, then falls back to sticky", () => {
    const rubric = createTurnQualityRubric();
    rubric.setSticky(["Always be thorough."]);
    rubric.setNext(["This turn only: answer with one sentence."]);

    expect(rubric.consumeForTurn()).toEqual(["This turn only: answer with one sentence."]);
    expect(rubric.consumeForTurn()).toEqual(["Always be thorough."]);
    expect(rubric.show()).toEqual(["Always be thorough."]);
  });

  it("replaces the sticky rubric when setSticky is called again", () => {
    const rubric = createTurnQualityRubric();
    rubric.setSticky(["Old criteria."]);
    rubric.setSticky(["New criteria."]);

    expect(rubric.consumeForTurn()).toEqual(["New criteria."]);
  });

  it("clears everything with clear", () => {
    const rubric = createTurnQualityRubric();
    rubric.setSticky(["Sticky criteria."]);
    rubric.setNext(["Next-turn criteria."]);
    rubric.clear();

    expect(rubric.show()).toBeUndefined();
    expect(rubric.consumeForTurn()).toBeUndefined();
  });

  it("clear is a no-op when nothing is set", () => {
    const rubric = createTurnQualityRubric();

    expect(() => rubric.clear()).not.toThrow();
    expect(rubric.show()).toBeUndefined();
  });

  it("rejects an empty criterion", () => {
    const rubric = createTurnQualityRubric();

    expect(() => rubric.setSticky([""])).toThrow();
    expect(() => rubric.setSticky(["   "])).toThrow();
    expect(() => rubric.setNext(["ok", ""])).toThrow();
  });

  it("rejects an empty criteria list", () => {
    const rubric = createTurnQualityRubric();

    expect(() => rubric.setSticky([])).toThrow();
    expect(() => rubric.setNext([])).toThrow();
  });

  it("does not leak stored criteria to callers mutating the returned array", () => {
    const rubric = createTurnQualityRubric();
    rubric.setSticky(["Original."]);

    const shown = rubric.show();
    shown?.push("Tampered.");

    expect(rubric.show()).toEqual(["Original."]);
    expect(rubric.consumeForTurn()).toEqual(["Original."]);
  });

  it("does not leak caller arrays passed to setters", () => {
    const rubric = createTurnQualityRubric();
    const criteria = ["Caller-owned."];
    rubric.setSticky(criteria);
    criteria.push("Caller-tampered.");

    expect(rubric.show()).toEqual(["Caller-owned."]);
  });

  it("show returns the effective rubric without consuming the next-turn one-shot", () => {
    const rubric = createTurnQualityRubric();
    rubric.setNext(["One-shot."]);

    expect(rubric.show()).toEqual(["One-shot."]);
    expect(rubric.show()).toEqual(["One-shot."]);
    expect(rubric.consumeForTurn()).toEqual(["One-shot."]);
    expect(rubric.show()).toBeUndefined();
  });

  it("exposes a stable TurnQualityRubric type", () => {
    const rubric: TurnQualityRubric = createTurnQualityRubric();

    expect(typeof rubric.setSticky).toBe("function");
    expect(typeof rubric.setNext).toBe("function");
    expect(typeof rubric.consumeForTurn).toBe("function");
    expect(typeof rubric.show).toBe("function");
    expect(typeof rubric.clear).toBe("function");
  });
});
