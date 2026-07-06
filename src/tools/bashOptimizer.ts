import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * The bash token optimizer (ADR 2026-07-05-every-session-dividends; RTK/squeez
 * strategies from requirements/gap-research §Gap 5). Strategies in order —
 * smart filter, grouping (command-aware), dedup, middle-truncation — bounded by
 * the NEVER-WORSE guard: an empty or larger result returns the original
 * untouched. Config-gated OFF by default (pilot posture); when on, results
 * carry a visible `[guru: N→M chars]` annotation so compression is never silent.
 */

export const BashOptimizerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Middle-truncation bounds (head/tail kept, middle elided). */
    headBytes: z.number().int().positive().default(8_192),
    tailBytes: z.number().int().positive().default(4_096),
    /** Only outputs larger than this are worth optimizing at all. */
    minBytes: z.number().int().positive().default(2_048)
  })
  .strict();
export type BashOptimizerConfig = z.infer<typeof BashOptimizerConfigSchema>;

export const DEFAULT_BASH_OPTIMIZER_CONFIG: BashOptimizerConfig = BashOptimizerConfigSchema.parse({});

/** Strategy 1 — smart filter: ANSI, progress spinners, blank runs, boilerplate. */
export function filterNoise(output: string): string {
  return output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "") // ANSI escapes
    .replace(/[^\n\r]*\r(?!\n)/gu, "") // CR-overwritten segments were visually replaced — drop them
    .replace(/^[\s]*[⠁⠂⠄⡀⢀⠠⠐⠈⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\-]+[\s]*$/gmu, "") // spinner frames
    .replace(/^\s*(?:npm (?:warn|notice) .*|yarn install v.*|info .*)$/gmu, "") // pkg-manager chatter
    .replace(/\n{3,}/gu, "\n\n");
}

/** Strategy 2 — grouping: collapse repeated error codes / identical prefixes. */
export function groupRepeats(output: string): string {
  const lines = output.split("\n");
  const codeCounts = new Map<string, { count: number; first: string }>();
  for (const line of lines) {
    const match = /\b(TS\d{4,5}|ERR_[A-Z_]+|E[A-Z]{3,})\b/u.exec(line);
    if (match && match[1] !== undefined) {
      const existing = codeCounts.get(match[1]);
      if (existing) {
        existing.count += 1;
      } else {
        codeCounts.set(match[1], { count: 1, first: line.trim().slice(0, 200) });
      }
    }
  }
  let grouped = output;
  for (const [code, info] of codeCounts) {
    if (info.count >= 5) {
      const pattern = new RegExp(`^.*\\b${code}\\b.*$\\n?`, "gmu");
      grouped = grouped.replace(pattern, "");
      grouped += `\n${code} (${info.count} occurrences): ${info.first}`;
    }
  }
  return grouped;
}

/** Strategy 3 — MIDDLE truncation: head has root causes, tail has final state.
 * The FULL output spills to disk (build plan §3B): truncation only affects what
 * enters the model context — evidence is never destroyed. */
export function middleTruncate(output: string, headBytes: number, tailBytes: number, spill?: (full: string) => string | null): string {
  if (output.length <= headBytes + tailBytes) {
    return output;
  }
  const elided = output.length - headBytes - tailBytes;
  const spillPath = spill ? spill(output) : null;
  const note = spillPath ? `[truncated ${elided} bytes from middle — full output at ${spillPath}]` : `[truncated ${elided} bytes]`;
  return `${output.slice(0, headBytes)}\n${note}\n${output.slice(-tailBytes)}`;
}

/** Strategy 4 — dedup: identical adjacent-ish lines collapse to one with ×N. */
export function dedupLines(output: string): string {
  const lines = output.split("\n");
  const out: string[] = [];
  let previous: string | null = null;
  let count = 0;
  const flush = (): void => {
    if (previous === null) {
      return;
    }
    out.push(count > 1 ? `[…×${count}] ${previous}` : previous);
    previous = null;
    count = 0;
  };
  for (const line of lines) {
    const normalized = line.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/gu, "<ts>").trim();
    if (previous !== null && normalized === previous && normalized.length > 0) {
      count += 1;
      continue;
    }
    flush();
    previous = normalized.length > 0 ? normalized : null;
    count = 1;
    if (previous === null) {
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

let spillDir: string | null = null;

/**
 * Best-effort full-output preservation; failure to spill never fails the turn.
 * The spilled file is SCRUBBED (shape+value) before it touches disk — the
 * constitution's never-at-rest clause applies to evidence files too (THERE v2
 * verification finding, 2026-07-05).
 */
function spillToDisk(full: string): string | null {
  try {
    const safe = scrubSecretValues(full);
    spillDir ??= mkdtempSync(join(tmpdir(), "guru-bash-"));
    const path = join(spillDir, `${createHash("sha256").update(safe).digest("hex").slice(0, 12)}.log`);
    writeFileSync(path, safe, "utf8");
    return path;
  } catch {
    return null;
  }
}

export interface OptimizeResult {
  readonly output: string;
  readonly optimized: boolean;
  /** Present when optimized: the visible annotation line. */
  readonly note?: string;
}

/**
 * Run the strategy pipeline under the never-worse guard. `command` enables
 * command-aware routing (list-y commands skip grouping, etc.).
 */
export function optimizeBashOutput(output: string, command: readonly string[], config: BashOptimizerConfig = DEFAULT_BASH_OPTIMIZER_CONFIG): OptimizeResult {
  if (!config.enabled || output.length < config.minBytes) {
    return { output, optimized: false };
  }
  const exe = (command[0] ?? "").toLowerCase();
  const testish = /^(npm|npx|yarn|pnpm|vitest|jest|cargo|go|pytest)$/u.test(exe) || command.some((part) => /test|vitest|jest/u.test(part));
  let candidate = filterNoise(output);
  if (testish) {
    candidate = groupRepeats(candidate);
  }
  candidate = dedupLines(candidate);
  candidate = middleTruncate(candidate, config.headBytes, config.tailBytes, spillToDisk);

  // THE NEVER-WORSE GUARD: empty or not-smaller results return the original.
  if (candidate.trim().length === 0 || candidate.length >= output.length) {
    return { output, optimized: false };
  }
  return {
    output: candidate,
    optimized: true,
    note: `[guru: bash output optimized ${output.length}→${candidate.length} chars]`
  };
}
