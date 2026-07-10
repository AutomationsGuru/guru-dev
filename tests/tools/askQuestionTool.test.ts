import { describe, expect, it, vi } from "vitest";

import {
  askQuestionsInteractively,
  createAskQuestionTools
} from "../../src/tools/builtins/askQuestionTool.js";

describe("ask_question", () => {
  it("uses injected onAsk callback", async () => {
    const onAsk = vi.fn(async () => [["Ship it"]]);
    const out = await askQuestionsInteractively(
      [{ question: "Ship?", options: ["Ship it", "Wait"], multiSelect: false }],
      { onAsk }
    );
    expect(out.interactive).toBe(true);
    expect(out.answers).toEqual([["Ship it"]]);
    expect(onAsk).toHaveBeenCalledOnce();
  });

  it("returns non-interactive summary when no TTY and no callback", async () => {
    const out = await askQuestionsInteractively(
      [{ question: "Color?", options: ["red", "blue"], multiSelect: false }],
      { isTty: () => false }
    );
    expect(out.interactive).toBe(false);
    expect(out.answers).toEqual([[]]);
    expect(out.summary).toMatch(/TTY/i);
  });

  it("parses numbered TTY answers via readLine", async () => {
    const lines = ["2"];
    const out = await askQuestionsInteractively(
      [{ question: "Pick", options: ["alpha", "beta", "gamma"], multiSelect: false }],
      {
        isTty: () => true,
        readLine: async () => lines.shift() ?? ""
      }
    );
    expect(out.answers).toEqual([["beta"]]);
    expect(out.interactive).toBe(true);
  });

  it("parses multi-select numbers", async () => {
    const out = await askQuestionsInteractively(
      [{ question: "Tags", options: ["a", "b", "c"], multiSelect: true }],
      {
        isTty: () => true,
        readLine: async () => "1,3"
      }
    );
    expect(out.answers).toEqual([["a", "c"]]);
  });

  it("registers tool id", async () => {
    const tools = createAskQuestionTools({
      onAsk: async () => [["x"]]
    });
    expect(tools[0]?.id).toBe("ask_question");
    const result = (await tools[0]!.execute(
      { questions: [{ question: "Q?", options: ["x", "y"], multiSelect: false }] },
      {}
    )) as { answers: string[][] };
    expect(result.answers[0]).toEqual(["x"]);
  });
});
