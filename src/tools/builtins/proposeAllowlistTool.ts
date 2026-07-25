import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { scrubSecretValues } from "../../safety/secretSafety.js";
import type { ToolDefinition } from "../registry.js";

/**
 * Allowlist-from-transcript PROPOSER (IDEA-E5, R-CC-ALLOW).
 *
 * Read-only ANALYSIS of observed session tool uses → a ranked list of shell
 * executables the operator *might* want on `runtimeHardening.shellAllowlist`.
 *
 * CONSTITUTIONAL RULE (VISION §3.5, plan exclusion "no silent hard-edge
 * removal"): this tool NEVER mutates the live config, never adds or removes a
 * hard edge, and never applies anything. Its only write is a NEW suggestions
 * file the operator reviews and applies by hand. `applied` is always false —
 * that field exists so callers cannot mistake a proposal for an applied change.
 *
 * Secret hygiene: executable names pass through the structural scrubber before
 * they can land in a suggestion — a secret-shaped token observed in a command
 * line is redacted, never replayed into an allowlist proposal.
 */

const ToolUseSchema = z.object({
  toolId: z.string().trim().min(1),
  /** Executable for shell tools; null/absent for non-shell tools. */
  executable: z.string().trim().min(1).nullable().optional(),
  count: z.number().int().nonnegative()
});

export const ProposeAllowlistToolInputSchema = z.object({
  /** Observed tool uses to analyze (from the session transcript/tool ledger). */
  toolUses: z.array(ToolUseSchema).min(1),
  /** Minimum observed count before an executable is suggested. */
  minCount: z.number().int().positive().default(2),
  /** Optional path for the suggestions file. When absent, no file is written. */
  outputPath: z.string().trim().min(1).optional(),
  /** Live config path — accepted ONLY to prove we never touch it. Never opened for write. */
  configPath: z.string().trim().min(1).optional()
});
export type ProposeAllowlistToolInput = z.infer<typeof ProposeAllowlistToolInputSchema>;

const AllowlistEntrySchema = z.object({
  executable: z.string(),
  count: z.number().int().nonnegative()
});

export const ProposeAllowlistToolOutputSchema = z.object({
  suggestions: z.array(z.string()),
  entries: z.array(AllowlistEntrySchema),
  /** Always false — this tool proposes, it never applies. */
  applied: z.literal(false),
  outputPath: z.string().optional(),
  summary: z.string()
});
export type ProposeAllowlistToolOutput = z.infer<typeof ProposeAllowlistToolOutputSchema>;

/** Tool ids whose uses count as shell executions for allowlist purposes. */
const SHELL_TOOL_IDS = new Set(["shell.exec", "shell_exec", "bash", "pi.bash", "bash.exec"]);

function isShellTool(toolId: string): boolean {
  return SHELL_TOOL_IDS.has(toolId) || /shell|bash/i.test(toolId);
}

export function createProposeAllowlistTool(): ToolDefinition<
  typeof ProposeAllowlistToolInputSchema,
  typeof ProposeAllowlistToolOutputSchema
> {
  return {
    id: "config.allowlist.propose",
    title: "Propose shell allowlist from transcript",
    description:
      "Read-only analysis of observed tool uses → shell-allowlist SUGGESTIONS file. Never modifies config or any hard edge; the operator reviews and applies by hand.",
    inputSchema: ProposeAllowlistToolInputSchema,
    outputSchema: ProposeAllowlistToolOutputSchema,
    // Honest marker (G1004): the analysis is read-only, but the tool can WRITE
    // a new suggestions file — so it must not claim the plan-mode "read-only"
    // trust marker. It still never touches live config.
    effect: "mutating",
    // Async so a sync guard throw (e.g. refusing to overwrite) surfaces as a
    // rejection rather than an uncaught throw through the registry boundary.
    async execute(input) {
      const counts = new Map<string, number>();
      for (const use of input.toolUses) {
        if (!isShellTool(use.toolId) || !use.executable) {
          continue;
        }
        // Structural scrub: a secret-shaped executable name is redacted, never proposed.
        const safe = scrubSecretValues(use.executable).trim();
        if (safe.length === 0) {
          continue;
        }
        counts.set(safe, (counts.get(safe) ?? 0) + use.count);
      }

      const entries = [...counts.entries()]
        .map(([executable, count]) => ({ executable, count }))
        .filter((entry) => entry.count >= input.minCount)
        .sort((a, b) => b.count - a.count || a.executable.localeCompare(b.executable));
      const suggestions = entries.map((entry) => entry.executable);

      let outputPath: string | undefined;
      if (input.outputPath) {
        const resolved = resolve(input.outputPath);
        if (existsSync(resolved)) {
          throw new Error(`suggestions file already exists: ${resolved} (refusing to overwrite)`);
        }
        mkdirSync(dirname(resolved), { recursive: true });
        const payload = {
          note: "Operator-reviewed SUGGESTIONS only. Nothing here has been applied; merge chosen entries into runtimeHardening.shellAllowlist by hand.",
          generatedBy: "config.allowlist.propose",
          minCount: input.minCount,
          suggestions,
          entries
        };
        writeFileSync(resolved, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" });
        outputPath = resolved;
      }

      return {
        suggestions,
        entries,
        applied: false,
        ...(outputPath ? { outputPath } : {}),
        summary: `Proposed ${suggestions.length} shell executable(s) from ${input.toolUses.length} observed tool use(s); nothing applied — operator review required.`
      };
    }
  };
}
