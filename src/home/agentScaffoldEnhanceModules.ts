/**
 * Minimal, portable project manifest for an agent's locally assembled skills.
 * Mirrors the scaffold lifecycle shape (name, version, skills[]) without
 * importing it, so this module stands alone until F502 lands.
 */
export interface AgentProjectManifest {
  readonly name: string;
  readonly version: number;
  readonly skills: readonly string[];
}

/**
 * Optional enhance modules an operator can layer onto a scaffolded agent
 * project. Flags are advisory markers on the manifest only: they never pull
 * in external tooling and never mutate core.
 */
export const SCAFFOLD_MODULE_FLAGS = ["cicd", "deploy", "rag"] as const;
export type ScaffoldModuleFlag = (typeof SCAFFOLD_MODULE_FLAGS)[number];

/** A scaffold manifest with any subset of the optional module flags set. */
export type EnhancedAgentProjectManifest = AgentProjectManifest &
  Partial<Record<ScaffoldModuleFlag, boolean>>;

/**
 * Set the requested optional module flags on a manifest. Pure: the input is
 * left untouched, existing flags and lifecycle state are preserved, and
 * unknown or duplicate module names are ignored.
 */
export function enhanceAgentProjectScaffoldModules(
  manifest: AgentProjectManifest,
  modules: readonly string[] = []
): EnhancedAgentProjectManifest {
  const enhanced: EnhancedAgentProjectManifest = { ...manifest };

  for (const module of modules) {
    if (isScaffoldModuleFlag(module)) {
      enhanced[module] = true;
    }
  }

  return enhanced;
}

function isScaffoldModuleFlag(module: string): module is ScaffoldModuleFlag {
  return (SCAFFOLD_MODULE_FLAGS as readonly string[]).includes(module);
}
