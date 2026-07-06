import { execFileSync } from "node:child_process";

import { z } from "zod";

/**
 * The never-stuck resolver (Phase G, 2026-07-04) — planning/THERE.md §11 +
 * acceptance scenario 4, and the trichotomy from the founding vision:
 *
 *   "I'm not stuck — I'll BUILD what I need."
 *   "I'm not stuck — I'll ATTACH to what's around me."
 *   "If a program already does what I do, I'll USE it — or LEARN how it does
 *    it and do it myself."
 *
 * Given a named capability gap, the resolver decides the move, STATES it with
 * its reasons (never silently), and returns a concrete work plan. It only ever
 * PROBES (registry lookups, PATH presence, manifest reads) — execution of the
 * plan stays behind the normal gates, and self-mutations behind the full
 * constitution (validation + CodeRabbit + approval + Done Packet).
 */

export const NeverStuckMoveSchema = z.enum(["already-have", "attach", "learn-replicate", "build"]);
export type NeverStuckMove = z.infer<typeof NeverStuckMoveSchema>;

export const CapabilityGapSchema = z
  .object({
    /** What's missing, in plain words (e.g. "fetch a web page", "send a slack message"). */
    need: z.string().trim().min(3).max(200),
    /** CLI commands that might already provide it (probed by PRESENCE on PATH only). */
    candidateCommands: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
    /** Programs known to do this (reference points for learn-replicate). */
    referencePrograms: z.array(z.string().trim().min(1).max(60)).max(8).default([])
  })
  .strict();

export type CapabilityGap = z.infer<typeof CapabilityGapSchema>;

export const NeverStuckResolutionSchema = z
  .object({
    move: NeverStuckMoveSchema,
    statement: z.string(),
    reasons: z.array(z.string()),
    /** Concrete next steps — execution happens through the normal gated tools. */
    workPlan: z.array(z.string()),
    /** Presence-only probe results (never versions/paths beyond the command name). */
    evidence: z.array(z.string())
  })
  .strict();

export type NeverStuckResolution = z.infer<typeof NeverStuckResolutionSchema>;

export interface ResolverContext {
  /** Tool ids registered in the live session. */
  readonly registeredToolIds: ReadonlySet<string>;
  /** Registered tool titles/descriptions, for need-matching. */
  readonly toolSummaries: ReadonlyMap<string, string>;
  /** Capability facts the garage has verified (memory facts of type capability/loadout verifiedTools). */
  readonly garageCapabilities?: readonly string[];
  /** PATH presence probe — injectable for tests. Presence only, never output. */
  readonly commandExists?: (command: string) => boolean;
}

function defaultCommandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [command], { stdio: ["ignore", "ignore", "ignore"], timeout: 5_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2)
  );
}

function overlap(need: Set<string>, candidate: string): number {
  const tokens = tokenize(candidate);
  let hits = 0;
  for (const token of need) {
    if (tokens.has(token)) {
      hits += 1;
    }
  }
  return need.size > 0 ? hits / need.size : 0;
}

/**
 * The trichotomy, in decision order:
 * 1. ALREADY-HAVE — a registered tool (or garage-verified capability) covers it.
 * 2. ATTACH — a capable command exists on this machine: wrap/use it through the
 *    gated shell surface, tracked as a parity gap to replace with a native build.
 * 3. LEARN-REPLICATE — a known program does it: study its interface, build our own.
 * 4. BUILD — nothing nearby: write the tool/extension ourselves, gated.
 */
export function resolveCapabilityGap(rawGap: CapabilityGap, context: ResolverContext): NeverStuckResolution {
  const gap = CapabilityGapSchema.parse(rawGap);
  const needTokens = tokenize(gap.need);
  const evidence: string[] = [];

  // Move 0 — already have it?
  for (const [toolId, summary] of context.toolSummaries) {
    if (overlap(needTokens, `${toolId} ${summary}`) >= 0.6) {
      return {
        move: "already-have",
        statement: `Not a gap: the registered tool '${toolId}' already covers "${gap.need}".`,
        reasons: [`tool '${toolId}' matches the need`, "no new capability required"],
        workPlan: [`Use the '${toolId}' tool directly.`],
        evidence: [`registered: ${toolId}`]
      };
    }
  }
  for (const capability of context.garageCapabilities ?? []) {
    if (overlap(needTokens, capability) >= 0.6) {
      return {
        move: "already-have",
        statement: `Not a gap: the garage has a verified capability covering "${gap.need}" (${capability}).`,
        reasons: ["a suit already earned this capability"],
        workPlan: [`Strap up the suit that carries '${capability}' (/role) and use it.`],
        evidence: [`garage: ${capability}`]
      };
    }
  }
  evidence.push("no registered tool or garage capability covers the need");

  // Move 1 — ATTACH: something capable is already on this machine.
  const commandExists = context.commandExists ?? defaultCommandExists;
  const canShell = context.registeredToolIds.has("bash") || context.registeredToolIds.has("shell.command.run");
  if (canShell) {
    for (const command of gap.candidateCommands) {
      if (commandExists(command)) {
        return {
          move: "attach",
          statement: `I'm not stuck — I'll ATTACH: '${command}' is already on this machine and can do "${gap.need}". I'll drive it through the gated shell surface, and track this as a parity gap to replace with a native build.`,
          reasons: [`'${command}' present on PATH (presence-only probe)`, "the gated bash surface can drive it now", "attach is the demoted-but-legitimate fallback (build later)"],
          workPlan: [
            `Run '${command}' through the bash tool (approval/mandate gates apply as normal).`,
            `Park the outcome with memory_remember (type: capability) so the garage keeps it.`,
            `Track a parity note: native '${gap.need}' tool to replace the attach (build move, gated PR).`
          ],
          evidence: [...evidence, `PATH: ${command} present`]
        };
      }
      evidence.push(`PATH: ${command} absent`);
    }
  }

  // Move 2 — LEARN-REPLICATE: a known program does this; study it, build our own.
  if (gap.referencePrograms.length > 0) {
    const reference = gap.referencePrograms[0] ?? "";
    return {
      move: "learn-replicate",
      statement: `I'm not stuck — I'll LEARN AND REPLICATE: ${reference} already does "${gap.need}". I'll study how it exposes the capability and build guru's own version through the gated self-build path.`,
      reasons: [`reference implementation exists: ${gap.referencePrograms.join(", ")}`, "no attachable command on this machine", "replicating keeps guru self-contained"],
      workPlan: [
        `Recon (read-only, swarm scouts welcome): study how ${reference} does "${gap.need}" — interface, inputs, outputs.`,
        "Design the guru-native tool/extension (zod schemas, frozen-seam registration).",
        "Implement + tests; ship through validation + CodeRabbit + approval + Done Packet."
      ],
      evidence
    };
  }

  // Move 3 — BUILD.
  return {
    move: "build",
    statement: `I'm not stuck — I'll BUILD what I need: nothing on this machine covers "${gap.need}", so guru grows the capability itself through the gated self-build path.`,
    reasons: ["no registered tool, garage capability, attachable command, or named reference", "building keeps the capability owned and inspectable"],
    workPlan: [
      `Design a minimal tool/extension for "${gap.need}" (zod schemas, registered through the extension host — no core edits).`,
      "Implement + focused tests.",
      "Ship through validation + CodeRabbit + approval + Done Packet; park the capability in the garage."
    ],
    evidence
  };
}
