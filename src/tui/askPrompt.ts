import { StringDecoder } from "node:string_decoder";

import { createKeyDecoder } from "./keys.js";
import { withInteractionGate } from "./interactionGate.js";

/**
 * Interactive multi-choice prompt for the `ask_question` tool.
 * Number keys select (1-based), ↑/↓ move, Enter confirms, Esc cancels.
 * Multi-select: Space toggles, Enter submits the selection set.
 */

export interface AskPromptQuestion {
  readonly question: string;
  readonly options: readonly string[];
  readonly is_multi_select?: boolean;
}

export interface AskPromptDeps {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: { write(text: string): unknown };
  readonly isTty?: boolean;
}

function writeLine(output: { write(text: string): unknown }, text: string): void {
  output.write(`${text}\n`);
}

/**
 * Prompt for one question. Returns selected option strings (empty on cancel).
 * Pure enough to unit-test with injectable streams; no paint/theme coupling.
 */
export function readQuestionAnswer(
  question: AskPromptQuestion,
  deps: AskPromptDeps = {}
): Promise<string[]> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const isTty = deps.isTty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

  if (!isTty) {
    return Promise.resolve([]);
  }

  const options = question.options;
  if (options.length === 0) {
    return Promise.resolve([]);
  }

  const multi = question.is_multi_select === true;
  let selected = 0;
  const toggled = new Set<number>();

  const render = (): void => {
    writeLine(output, "");
    writeLine(output, `  ? ${question.question}`);
    options.forEach((opt, index) => {
      const mark = multi ? (toggled.has(index) ? "[x]" : "[ ]") : index === selected ? "▸" : " ";
      const focus = !multi && index === selected ? ">" : multi && index === selected ? ">" : " ";
      writeLine(output, `  ${focus}${mark} ${index + 1}. ${opt}`);
    });
    writeLine(
      output,
      multi
        ? "  [1-9] toggle · ↑/↓ · space toggle · enter submit · esc cancel"
        : "  [1-9] pick · ↑/↓ · enter confirm · esc cancel"
    );
  };

  return withInteractionGate(
    () =>
      new Promise<string[]>((resolve) => {
        let cleaned = false;
        const cleanup = (): void => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          input.off("data", onData);
          decoder.dispose();
        };
        const finish = (answers: string[]): void => {
          cleanup();
          resolve(answers);
        };
        const decoder = createKeyDecoder((key) => {
          const name = (key.name ?? "").toLowerCase();
          if (name === "paste") {
            return;
          }
          if ((key.ctrl === true && name === "c") || name === "escape") {
            writeLine(output, "  → cancelled");
            finish([]);
            return;
          }
          if (name === "up") {
            selected = (selected - 1 + options.length) % options.length;
            render();
            return;
          }
          if (name === "down") {
            selected = (selected + 1) % options.length;
            render();
            return;
          }
          if (multi && (name === "space" || key.sequence === " ")) {
            if (toggled.has(selected)) {
              toggled.delete(selected);
            } else {
              toggled.add(selected);
            }
            render();
            return;
          }
          if (name === "return" || name === "enter") {
            if (multi) {
              const picks =
                toggled.size > 0
                  ? [...toggled].sort((a, b) => a - b).map((i) => options[i] ?? "")
                  : [options[selected] ?? ""];
              writeLine(output, `  → ${picks.join(", ")}`);
              finish(picks.filter((p) => p.length > 0));
              return;
            }
            const pick = options[selected] ?? "";
            writeLine(output, `  → ${pick}`);
            finish(pick.length > 0 ? [pick] : []);
            return;
          }
          // Digit 1-9 (and 0 as 10th) — quick pick / toggle.
          if (key.sequence && key.sequence.length === 1) {
            const ch = key.sequence;
            if (ch >= "1" && ch <= "9") {
              const index = Number(ch) - 1;
              if (index < options.length) {
                if (multi) {
                  selected = index;
                  if (toggled.has(index)) {
                    toggled.delete(index);
                  } else {
                    toggled.add(index);
                  }
                  render();
                } else {
                  const pick = options[index] ?? "";
                  writeLine(output, `  → ${pick}`);
                  finish(pick.length > 0 ? [pick] : []);
                }
              }
              return;
            }
            if (ch === "0" && options.length >= 10) {
              if (multi) {
                selected = 9;
                if (toggled.has(9)) {
                  toggled.delete(9);
                } else {
                  toggled.add(9);
                }
                render();
              } else {
                const pick = options[9] ?? "";
                writeLine(output, `  → ${pick}`);
                finish(pick.length > 0 ? [pick] : []);
              }
            }
          }
        });
        const utf8 = new StringDecoder("utf8");
        const onData = (chunk: Buffer | string): void => {
          decoder.feed(typeof chunk === "string" ? chunk : utf8.write(chunk));
        };
        render();
        input.on("data", onData);
      })
  );
}

/** Ask a sequence of questions; each answer is an array of selected option strings. */
export async function readAskQuestions(
  questions: readonly AskPromptQuestion[],
  deps: AskPromptDeps = {}
): Promise<string[][]> {
  const answers: string[][] = [];
  for (const q of questions) {
    answers.push(await readQuestionAnswer(q, deps));
  }
  return answers;
}
