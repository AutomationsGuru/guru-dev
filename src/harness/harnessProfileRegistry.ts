import { MANDATE_READ_ONLY_TOOLS } from "../mandates/evaluate.js";
import type { ToolDefinition } from "../tools/registry.js";
import type { HarnessProfile, HarnessProfileId, PresentedTool } from "./harnessProfile.js";
import { minimalProfile } from "./profiles/minimal.js";

/**
 * Harness profile registry (IDEA-F100-HARNESS-PROFILES-01).
 *
 * Profiles reshape the model-facing prompt and tool-schema presentation;
 * Guru's own runtime still executes the tools and the mandate layer still
 * enforces hard limits. Hard-limit interpretation: MANDATE_READ_ONLY_TOOLS is
 * the non-removable baseline. Registration refuses any profile whose
 * hardLimitToolIds omits a baseline id, and surface resolution always keeps
 * hard-limit tools that exist in the input tool list — present, unhidden, and
 * under their canonical label — so the always-allowed floor is non-bypassable
 * by construction (a profile can never narrow what stays deny-auto safe).
 */

export interface HarnessProfileRegistry {
  register(profile: HarnessProfile): void;
  get(id: HarnessProfileId): HarnessProfile | undefined;
  list(): readonly HarnessProfile[];
  /** Resolve a profile by id; throws a clear error on unknown id. */
  resolveProfile(id: HarnessProfileId): HarnessProfile;
}

const nativeProfile: HarnessProfile = {
  id: "native",
  description: "Guru's own shape: full prompt parts, full tool surface, native tool-calling.",
  systemPromptParts: [
    "You are Guru, an agent running on the GuruHarness runtime.",
    "Use the provided tools to observe and change the workspace.",
    "Prefer read-only tools before mutating tools."
  ],
  toolSurface: {},
  responseMode: "tools",
  hardLimitToolIds: [...MANDATE_READ_ONLY_TOOLS]
};

/**
 * Stub shaped profiles: present prompt/tool schemas in shapes other harnesses
 * use, without adopting their runtime (harness emulation on own runtime).
 */
const claudeShapedProfile: HarnessProfile = {
  id: "claude-shaped",
  description: "Stub: Claude-shaped prompt/tool presentation on Guru's runtime.",
  systemPromptParts: ["You are an agent with tool use.", "Call tools by name with JSON input."],
  toolSurface: {},
  responseMode: "tools",
  hardLimitToolIds: [...MANDATE_READ_ONLY_TOOLS]
};

const kimiShapedProfile: HarnessProfile = {
  id: "kimi-shaped",
  description: "Stub: Kimi-shaped prompt/tool presentation on Guru's runtime.",
  systemPromptParts: ["You are a helpful coding agent.", "Invoke tools with structured arguments."],
  toolSurface: {},
  responseMode: "tools",
  hardLimitToolIds: [...MANDATE_READ_ONLY_TOOLS]
};

function assertHardLimitBaseline(profile: HarnessProfile): void {
  const declared = new Set(profile.hardLimitToolIds);
  const missing = [...MANDATE_READ_ONLY_TOOLS].filter((id) => !declared.has(id));

  if (missing.length > 0) {
    throw new Error(
      `Profile ${profile.id} omits hard-limit baseline tool ids: ${missing.join(", ")}`
    );
  }
}

export function createHarnessProfileRegistry(
  builtins: readonly HarnessProfile[] = [nativeProfile, minimalProfile, claudeShapedProfile, kimiShapedProfile]
): HarnessProfileRegistry {
  const profiles = new Map<HarnessProfileId, HarnessProfile>();

  const registry: HarnessProfileRegistry = {
    register(profile) {
      assertHardLimitBaseline(profile);
      if (profiles.has(profile.id)) {
        throw new Error(`Harness profile already registered: ${profile.id}`);
      }

      profiles.set(profile.id, profile);
    },
    get(id) {
      return profiles.get(id);
    },
    list() {
      return [...profiles.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    resolveProfile(id) {
      const profile = profiles.get(id);

      if (!profile) {
        throw new Error(`Unknown harness profile: ${id}`);
      }

      return profile;
    }
  };

  for (const profile of builtins) {
    registry.register(profile);
  }

  return registry;
}

/**
 * Map ToolDefinition[] to the presented surface for a profile. Hard-limit
 * tools that exist in the input list always survive: narrowing via
 * `toolSurface.include` cannot drop them, and `hidden`/label overrides are
 * ignored for them so the floor is never renamed away or hidden.
 */
export function resolveProfileSurface(
  profile: HarnessProfile,
  tools: readonly ToolDefinition[]
): readonly PresentedTool[] {
  const hardLimitIds = new Set(profile.hardLimitToolIds);
  const include = profile.toolSurface.include ? new Set(profile.toolSurface.include) : undefined;

  return tools
    .filter((tool) => hardLimitIds.has(tool.id) || !include || include.has(tool.id))
    .map((tool) => {
      const hardLimit = hardLimitIds.has(tool.id);
      const override = profile.toolSurface.overrides?.[tool.id];

      return {
        toolId: tool.id,
        label: hardLimit ? tool.title : (override?.label ?? tool.title),
        description: hardLimit ? tool.description : (override?.description ?? tool.description),
        hidden: hardLimit ? false : (override?.hidden ?? false),
        hardLimit
      };
    });
}
