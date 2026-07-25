export const INITIAL_AGENT_PROJECT_VERSION = 1;

/** Minimal, portable project state for an agent's locally assembled skills. */
export interface AgentProjectManifest {
  readonly name: string;
  readonly version: number;
  readonly skills: readonly string[];
}

export interface CreateAgentProjectManifestOptions {
  readonly name: string;
  readonly skills?: readonly string[];
}

export interface EnhanceAgentProjectManifestOptions {
  readonly name?: string;
  readonly skills?: readonly string[];
}

/** Create a fresh manifest without touching the filesystem or external state. */
export function createAgentProjectManifest(options: CreateAgentProjectManifestOptions): AgentProjectManifest {
  return {
    name: normalizeName(options.name),
    version: INITIAL_AGENT_PROJECT_VERSION,
    skills: normalizeSkills(options.skills ?? [])
  };
}

/** Add project skills without discarding the manifest's prior lifecycle state. */
export function enhanceAgentProjectManifest(
  manifest: AgentProjectManifest,
  options: EnhanceAgentProjectManifestOptions = {}
): AgentProjectManifest {
  assertManifest(manifest);

  return {
    name: options.name === undefined ? manifest.name : normalizeName(options.name),
    version: manifest.version,
    skills: normalizeSkills([...manifest.skills, ...(options.skills ?? [])])
  };
}

/** Mark a manifest as upgraded while retaining its project identity and skills. */
export function upgradeAgentProjectManifest(manifest: AgentProjectManifest): AgentProjectManifest {
  assertManifest(manifest);

  return {
    name: manifest.name,
    version: manifest.version + 1,
    skills: [...manifest.skills]
  };
}

function assertManifest(manifest: AgentProjectManifest): void {
  normalizeName(manifest.name);
  if (!Number.isSafeInteger(manifest.version) || manifest.version < INITIAL_AGENT_PROJECT_VERSION) {
    throw new Error("Agent project manifest version must be a positive safe integer.");
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("Agent project manifest name must not be empty.");
  }
  return normalized;
}

function normalizeSkills(skills: readonly string[]): string[] {
  return [...new Set(skills.map((skill) => skill.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
