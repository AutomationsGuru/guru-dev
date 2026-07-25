import { describe, expect, it } from "vitest";

import {
  AskUserInputSchema,
  AskUserQuestionSchema,
  validateAskUserAnswers,
  type AskUserQuestion
} from '../../src/tools/askUser/schema.js';
import { createAskUserQuestionTool } from '../../src/tools/builtins/askUserQuestionTool.js';

describe("ask_user_question schema", () => {
  it("accepts valid question with 2-4 options", () => {
    const q = {
      question: "Pick a color",
      options: ["Red", "Blue"],
      multiSelect: false,
      allowOther: true
    };
    const parsed = AskUserQuestionSchema.parse(q);
    expect(parsed.options).toHaveLength(2);
    expect(parsed.allowOther).toBe(true);
  });

  it("rejects fewer than 2 options", () => {
    const q = {
      question: "Pick",
      options: ["OnlyOne"]
    };
    expect(() => AskUserQuestionSchema.parse(q)).toThrow();
  });

  it("rejects more than 4 options", () => {
    const q = {
      question: "Pick",
      options: ["A", "B", "C", "D", "E"]
    };
    expect(() => AskUserQuestionSchema.parse(q)).toThrow();
  });

  it("accepts multiSelect flag", () => {
    const q = {
      question: "Select all that apply",
      options: ["A", "B", "C"],
      multiSelect: true
    };
    const parsed = AskUserQuestionSchema.parse(q);
    expect(parsed.multiSelect).toBe(true);
  });
});

describe("ask_user_question input schema", () => {
  it("accepts 1-8 questions", () => {
    const input = {
      questions: [
        { question: "Q1", options: ["A", "B"], multiSelect: false, allowOther: true },
        { question: "Q2", options: ["C", "D", "E"], multiSelect: false, allowOther: true }
      ]
    };
    const parsed = AskUserInputSchema.parse(input);
    expect(parsed.questions).toHaveLength(2);
  });

  it("rejects empty questions array", () => {
    const input = { questions: [] };
    expect(() => AskUserInputSchema.parse(input)).toThrow();
  });
});

describe("ask_user_question answer validation", () => {
  const questions: AskUserQuestion[] = [
    { question: "Color?", options: ["Red", "Blue"], multiSelect: false, allowOther: true },
    { question: "Size?", options: ["S", "M", "L"], multiSelect: false, allowOther: false }
  ];

  it("validates matching answer count", () => {
    const answers = [["Red"], ["M"]];
    const err = validateAskUserAnswers(questions, answers);
    expect(err).toBeNull();
  });

  it("rejects wrong answer count", () => {
    const answers = [["Red"]];
    const err = validateAskUserAnswers(questions, answers);
    expect(err).toContain("expected 2");
  });

  it("rejects non-array answers", () => {
    const answers = "not-an-array" as unknown as string[][];
    const err = validateAskUserAnswers(questions, answers);
    expect(err).toContain("must be an array");
  });

  it("rejects single-select with multiple answers", () => {
    const answers = [["Red"], ["S", "M"]];
    const err = validateAskUserAnswers(questions, answers);
    expect(err).toContain("single-select");
  });

  it("accepts Other when allowOther is true", () => {
    const answers = [["Other"], ["M"]];
    const err = validateAskUserAnswers(questions, answers);
    expect(err).toBeNull();
  });

  it("rejects Other when allowOther is false", () => {
    const answers = [["Red"], ["Other"]];
    const err = validateAskUserAnswers(questions, answers);
    expect(err).toContain("not a valid option or Other");
  });

  it("rejects unknown option text", () => {
    const answers = [["Green"], ["M"]];
    const err = validateAskUserAnswers(questions, answers);
    expect(err).toContain("not a valid option");
  });
});

describe("ask_user_question tool", () => {
  it("creates tool with correct id", () => {
    const tool = createAskUserQuestionTool();
    expect(tool.id).toBe("ask_user_question");
    expect(tool.effect).toBe("read-only");
  });

  it("executes with onAsk handler and returns answers", async () => {
    const tool = createAskUserQuestionTool({
      onAsk: async (qs) => qs.map(() => ["A"])
    });
    const result = await tool.execute(
      { questions: [{ question: "Test?", options: ["A", "B"], multiSelect: false, allowOther: true }] },
      {}
    );
    expect(result.answers).toEqual([["A"]]);
    expect(result.summary).toContain("Q1");
  });

  it("returns pendingQuestionId when registerPending provided", async () => {
    const tool = createAskUserQuestionTool({
      registerPending: async () => "pending-123"
    });
    const result = await tool.execute(
      { questions: [{ question: "Test?", options: ["A", "B"], multiSelect: false, allowOther: true }] },
      {}
    );
    expect(result.pendingQuestionId).toBe("pending-123");
    expect(result.answers).toEqual([]);
  });

  it("rejects invalid answers from onAsk", async () => {
    const tool = createAskUserQuestionTool({
      onAsk: async () => [["InvalidOption"]]
    });
    await expect(
      tool.execute({ questions: [{ question: "Test?", options: ["A", "B"], multiSelect: false, allowOther: true }] }, {})
    ).rejects.toThrow("not a valid option");
  });

  it("returns empty answers when non-TTY and no handler", async () => {
    const tool = createAskUserQuestionTool({
      isTty: () => false
    });
    const result = await tool.execute(
      { questions: [{ question: "Test?", options: ["A", "B"], multiSelect: false, allowOther: true }] },
      {}
    );
    expect(result.answers).toEqual([[]]);
    expect(result.summary).toContain("requires an interactive TUI");
  });
});