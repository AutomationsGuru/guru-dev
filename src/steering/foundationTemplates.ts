import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type FoundationTemplateKind = "product" | "tech" | "structure" | "all";

export interface GenerateFoundationTemplatesOptions {
  /** Existing project directory that will receive optional `.guru/steering` files. */
  readonly projectRoot: string;
  /** One foundation file, or every foundation file in deterministic order. */
  readonly kind: FoundationTemplateKind;
}

const STEERING_DIRECTORY = [".guru", "steering"] as const;
const FOUNDATION_KINDS = ["product", "tech", "structure"] as const;

/**
 * Create selected foundation steering files for a project without altering any
 * existing operator-authored steering. The generated skeletons are
 * local, optional starting points; no network or external schema is involved.
 */
export function generateTemplates(options: GenerateFoundationTemplatesOptions): readonly string[] {
  const projectRoot = resolve(options.projectRoot);
  const projectName = projectNameFor(projectRoot);
  const steeringDirectory = join(projectRoot, ...STEERING_DIRECTORY);
  const templateKinds = options.kind === "all" ? FOUNDATION_KINDS : [options.kind];
  const templateContext = {
    projectName,
    stackHints: detectStackHints(projectRoot),
    topLevelDirectories: detectTopLevelDirectories(projectRoot)
  };

  const paths = templateKinds.map((kind) => join(steeringDirectory, `${kind}.md`));
  const existingPath = paths.find((path) => existsSync(path));
  if (existingPath) {
    throw new Error(`Refusing to overwrite existing steering file: ${existingPath}`);
  }

  mkdirSync(steeringDirectory, { recursive: true });

  for (const [index, path] of paths.entries()) {
    writeFileSync(path, renderTemplate(templateKinds[index] as Exclude<FoundationTemplateKind, "all">, templateContext), {
      encoding: "utf8",
      flag: "wx"
    });
  }

  return paths;
}

interface TemplateContext {
  readonly projectName: string;
  readonly stackHints: readonly string[];
  readonly topLevelDirectories: readonly string[];
}

function renderTemplate(kind: Exclude<FoundationTemplateKind, "all">, context: TemplateContext): string {
  switch (kind) {
    case "product":
      return renderProductTemplate(context.projectName);
    case "tech":
      return renderTechTemplate(context.projectName, context.stackHints);
    case "structure":
      return renderStructureTemplate(context.projectName, context.topLevelDirectories);
  }
}

function renderProductTemplate(projectName: string): string {
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
    "- Record the next product questions that should shape planning or review.",
    ""
  ].join("\n");
}

function renderTechTemplate(projectName: string, stackHints: readonly string[]): string {
  const stackLines = stackHints.length > 0 ? stackHints.map((hint) => `- ${hint}`) : ["- No stack hints detected yet."];

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
    "- Capture environment constraints, tooling assumptions, and platform parity notes here.",
    ""
  ].join("\n");
}

function renderStructureTemplate(projectName: string, directories: readonly string[]): string {
  const directoryLines =
    directories.length > 0
      ? directories.map((directory) => `- \`${directory}\` — describe what this area owns.`)
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
    "- Update this map when durable structure or boundaries change.",
    ""
  ].join("\n");
}

function projectNameFor(projectRoot: string): string {
  const name = basename(projectRoot).trim();
  return name.length > 0 ? name : "Unnamed project";
}

function detectTopLevelDirectories(projectRoot: string): string[] {
  return readProjectEntries(projectRoot).filter((entry) => entry !== ".guru" && statSync(join(projectRoot, entry)).isDirectory());
}

function detectStackHints(projectRoot: string): string[] {
  const projectEntries = readProjectEntries(projectRoot);
  const entries = new Set(projectEntries);
  const hints: string[] = [];

  if (entries.has("package.json")) {
    hints.push("Node.js / TypeScript or JavaScript project (package.json)");
  }
  if (entries.has("pyproject.toml") || entries.has("requirements.txt")) {
    hints.push("Python project");
  }
  if (entries.has("Cargo.toml")) {
    hints.push("Rust project");
  }
  if (entries.has("go.mod")) {
    hints.push("Go project");
  }
  if (entries.has("pom.xml") || entries.has("build.gradle") || entries.has("build.gradle.kts")) {
    hints.push("JVM project");
  }
  if (projectEntries.some((entry) => entry.endsWith(".sln") || entry.endsWith(".csproj"))) {
    hints.push(".NET project");
  }

  return hints;
}

function readProjectEntries(projectRoot: string): string[] {
  try {
    return readdirSync(projectRoot).sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}
