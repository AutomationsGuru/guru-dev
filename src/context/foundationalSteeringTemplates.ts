export interface FoundationalSteeringTemplateInput {
  readonly projectName: string;
  readonly stackHints?: readonly string[];
  readonly topLevelDirectories?: readonly string[];
}

export function generateProduct(input: FoundationalSteeringTemplateInput): string {
  const projectName = formatProjectName(input.projectName);

  return [
    `# Product steering — ${projectName}`,
    "",
    "## Product identity",
    `- Project: ${projectName}`,
    "- Core outcome: Describe the operator-facing result this project must reliably deliver.",
    "- Primary users: Name the operators, teammates, or systems this project serves.",
    "",
    "## Success signals",
    "- Reliability: Define the behaviors that must work every day.",
    "- Quality: Capture the acceptance bar, evidence, and guardrails for changes.",
    "- Scope: State the problem this project owns and the adjacent problems it should not absorb.",
    "",
    "## Product notes",
    "- Add mission constraints, non-goals, and rollout expectations here.",
    "- Record the next product questions that should shape planning or review."
  ].join("\n");
}

export function generateTech(input: FoundationalSteeringTemplateInput): string {
  const projectName = formatProjectName(input.projectName);
  const stackHints = normalizeList(input.stackHints);
  const stackLines =
    stackHints.length > 0
      ? stackHints.map((hint) => `- ${hint}`)
      : ["- No stack hints detected yet."];

  return [
    `# Technical steering — ${projectName}`,
    "",
    "## Runtime and stack",
    `- Project: ${projectName}`,
    ...stackLines,
    "",
    "## Architecture guidance",
    "- Document the owned runtime, extension seams, and important subsystem boundaries here.",
    "- Call out any ATTACH dependencies, migration triggers, and paths to native ownership.",
    "",
    "## Validation",
    "- List the typechecks, tests, and smoke checks required before shipping.",
    "- Capture environment constraints, tooling assumptions, and platform parity notes here."
  ].join("\n");
}

export function generateStructure(input: FoundationalSteeringTemplateInput): string {
  const projectName = formatProjectName(input.projectName);
  const topLevelDirectories = normalizeList(input.topLevelDirectories);
  const directoryLines =
    topLevelDirectories.length > 0
      ? topLevelDirectories.map((directory) => `- \`${directory}\` — describe what this area owns.`)
      : ["- No top-level directories detected yet."];

  return [
    `# Structure steering — ${projectName}`,
    "",
    "## Top-level directories",
    ...directoryLines,
    "",
    "## Ownership map",
    "- Define where new work should land and which areas are shared, generated, or read-only.",
    "- Note any directories that require special review, migration, or validation steps.",
    "",
    "## Change guidance",
    "- Keep new files in the narrowest owning directory.",
    "- Update this map when durable structure or boundaries change."
  ].join("\n");
}

function formatProjectName(projectName: string): string {
  const trimmed = projectName.trim();
  return trimmed.length > 0 ? trimmed : "Unnamed project";
}

function normalizeList(values: readonly string[] | undefined): string[] {
  if (!values) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}
