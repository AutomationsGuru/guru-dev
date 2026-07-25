import { z } from "zod";

/**
 * Structured plan artifact (IDEA-A1) — the operator-facing plan the operator
 * can accept or revise before leaving plan mode.
 *
 * The artifact is a fixed eight-section shape. Empty sections are kept
 * VISIBLE (serialized as empty arrays / rendered as an explicit placeholder),
 * never omitted, so an operator reviewing the plan can see at a glance which
 * sections the planner left unaddressed. Pure schema + renderer: no I/O, no
 * execution. Accepting an artifact is an operator decision recorded elsewhere;
 * this module never executes writes itself.
 */

export const PLAN_ARTIFACT_SECTIONS = Object.freeze([
  "objective",
  "sources",
  "critical_files",
  "constraints",
  "approach",
  "verification",
  "risks",
  "handoff_notes"
] as const);
export type PlanArtifactSection = (typeof PLAN_ARTIFACT_SECTIONS)[number];

const MAX_SERIALIZED_LENGTH = 20_000;

const SectionEntrySchema = z.string().trim().min(1);

const CriticalFileSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), {
    message: "Critical files must not contain NUL characters."
  })
  .refine((value) => !/(^|[\\/])\.\.([\\/]|$)/.test(value), {
    message: "Critical files must not contain path traversal segments."
  });

export const PlanArtifactSchema = z
  .object({
    objective: z.string().trim().min(1).max(4_000),
    sources: z.array(SectionEntrySchema),
    critical_files: z.array(CriticalFileSchema),
    constraints: z.array(SectionEntrySchema),
    approach: z.array(SectionEntrySchema),
    verification: z.array(SectionEntrySchema),
    risks: z.array(SectionEntrySchema),
    handoff_notes: z.array(SectionEntrySchema)
  })
  .strict()
  .superRefine((artifact, context) => {
    if (JSON.stringify(artifact).length > MAX_SERIALIZED_LENGTH) {
      context.addIssue({
        code: "custom",
        message: `Plan artifact exceeds the maximum serialized size of ${MAX_SERIALIZED_LENGTH} characters.`
      });
    }
  });
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

export type PlanArtifactResult =
  | { readonly ok: true; readonly artifact: PlanArtifact }
  | { readonly ok: false; readonly error: string };

export function parsePlanArtifact(input: unknown): PlanArtifactResult {
  const result = PlanArtifactSchema.safeParse(input);

  if (result.success) {
    return { ok: true, artifact: result.data };
  }

  return {
    ok: false,
    error: result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
      .join("; ")
  };
}

/**
 * Build an artifact skeleton with every section present and only the
 * objective filled. Every other section is an empty (but visible) array, so a
 * renderer never has to guess whether a section exists.
 */
export function createEmptyPlanArtifact(objective: string): PlanArtifact {
  return PlanArtifactSchema.parse({
    objective,
    sources: [],
    critical_files: [],
    constraints: [],
    approach: [],
    verification: [],
    risks: [],
    handoff_notes: []
  });
}

const SECTION_TITLES: Record<PlanArtifactSection, string> = {
  objective: "Objective",
  sources: "Sources / Context",
  critical_files: "Critical Files",
  constraints: "Constraints",
  approach: "Approach",
  verification: "Verification",
  risks: "Risks",
  handoff_notes: "Handoff Notes"
};

const EMPTY_SECTION_PLACEHOLDER = "_(none)_";

/**
 * Render the artifact as operator-reviewable Markdown. Every section heading
 * is emitted even when its list is empty — an empty section renders as an
 * explicit placeholder line, never omitted, so the operator sees exactly what
 * the plan does and does not cover.
 */
export function serializePlanArtifact(artifact: PlanArtifact): string {
  const lines: string[] = ["# Plan", ""];

  for (const section of PLAN_ARTIFACT_SECTIONS) {
    lines.push(`## ${SECTION_TITLES[section]} (${section})`, "");

    if (section === "objective") {
      lines.push(artifact.objective, "");
      continue;
    }

    const entries = artifact[section];
    if (entries.length === 0) {
      lines.push(EMPTY_SECTION_PLACEHOLDER, "");
    } else {
      for (const entry of entries) {
        lines.push(`- ${entry}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}
