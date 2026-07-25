import { describe, expect, it } from "vitest";

import { validateAsk } from '../../src/session/askUserStructured.js';

describe("validateAsk", () => {
  it("accepts a structured prompt with a question and options", () => {
    expect(
      validateAsk({
        question: "Which validation should run?",
        options: ["Focused tests", "Full suite"]
      })
    ).toEqual({
      question: "Which validation should run?",
      options: ["Focused tests", "Full suite"]
    });
  });

  it("rejects an empty options array before the prompt is presented", () => {
    expect(() => validateAsk({ question: "Which validation should run?", options: [] })).toThrow();
  });
});
