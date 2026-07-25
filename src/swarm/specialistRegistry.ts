import { SpecialistConfigSchema, type SpecialistConfig } from "./specialistSchema.js";

export interface SpecialistRegistry {
  register(config: SpecialistConfig): void;
  get(name: string): SpecialistConfig | undefined;
  list(): readonly SpecialistConfig[];
  resolve(name: string): SpecialistConfig | undefined;
}

export const BUILTIN_SPECIALISTS: readonly SpecialistConfig[] = [
  {
    name: "library-research",
    systemPrompt: "You are a library research specialist agent. Your goal is to research existing libraries, documentation, files, and patterns to find the exact information requested. Be thorough and precise.",
    allowedTools: ["read", "grep", "glob", "ls"]
  },
  {
    name: "code-analysis",
    systemPrompt: "You are a code analysis specialist agent. Your goal is to analyze source code structure, verify definitions, check references, and examine compile-time/runtime diagnostics. Be methodical and analytical.",
    allowedTools: ["read", "grep", "glob", "ls", "read_diagnostics"]
  }
];

export function createSpecialistRegistry(
  initialConfigs: readonly SpecialistConfig[] = BUILTIN_SPECIALISTS
): SpecialistRegistry {
  const specialists = new Map<string, SpecialistConfig>();

  const registry: SpecialistRegistry = {
    register(config) {
      const parsed = SpecialistConfigSchema.parse(config);
      if (specialists.has(parsed.name)) {
        throw new Error(`Specialist already registered: ${parsed.name}`);
      }
      specialists.set(parsed.name, parsed);
    },
    get(name) {
      return specialists.get(name);
    },
    list() {
      return [...specialists.values()];
    },
    resolve(name) {
      return specialists.get(name);
    }
  };

  for (const config of initialConfigs) {
    registry.register(config);
  }

  return registry;
}

let sharedRegistry: SpecialistRegistry | undefined;

export function getSharedSpecialistRegistry(): SpecialistRegistry {
  if (!sharedRegistry) {
    sharedRegistry = createSpecialistRegistry();
  }
  return sharedRegistry;
}

/** Test-only: reset the process-shared registry. */
export function resetSharedSpecialistRegistryForTests(): void {
  sharedRegistry = undefined;
}

/**
 * Clamps offered tools to the specialist's allowed subset.
 */
export function clampSpecialistTools(
  specialistAllowedTools: readonly string[],
  offeredTools: readonly { id: string }[]
): string[] {
  const allowedSet = new Set(specialistAllowedTools);
  return offeredTools
    .filter((tool) => allowedSet.has(tool.id))
    .map((tool) => tool.id);
}
