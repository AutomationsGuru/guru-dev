import { ResourceReloadTargetSchema } from "./resourceReloadTypes.js";
import { discoverSkills } from "../skills/loader.js";
import { loadTheme } from "../tui/theme.js";
import type {
  ResourceReloadContext,
  ResourceReloadExtensionsSnapshot,
  ResourceReloadResult,
  ResourceReloadSkillsSnapshot,
  ResourceReloadSummary,
  ResourceReloadTarget,
  ResourceReloadThemeSnapshot
} from "./resourceReloadTypes.js";

/**
 * Unified resource reload for skills, theme, and extension registrations.
 *
 * - Skills: stateless re-discovery from the configured directories.
 * - Theme: fresh file read; missing/invalid theme → kit defaults.
 * - Extensions: rebuild the host registration slate from scratch.
 *
 * The reload preserves provenance and trust gates: it never bypasses mandate,
 * plan-mode certification, or runtime policy. It only refreshes the loadable
 * resource surface so later sessions/Turns observe fresh state.
 *
 * NOTE: this is the RELOAD ENGINE. RPC/TUI call sites are NOT wired here;
 * the future wire path is documented in the owning evidence packet.
 */

export function createResourceReloader(context: ResourceReloadContext) {
  return {
    /**
     * Reload one or more resource targets.
     * Invalid targets are rejected (fail-closed) rather than ignored.
     */
    async reload(targets: readonly ResourceReloadTarget[]): Promise<ResourceReloadResult> {
      const normalized = [...targets];
      const summaries: ResourceReloadSummary[] = [];
      for (const target of normalized) {
        summaries.push(await reloadTarget(context, target));
      }
      const ok = summaries.length > 0 && summaries.every((summary) => summary.ok);
      return { summaries, ok };
    },

    /**
     * Reload all known resource targets.
     */
    async reloadAll(): Promise<ResourceReloadResult> {
      return this.reload(ResourceReloadTargetSchema.options);
    }
  };
}

/**
 * Convenience one-shot: reload the named targets and return the result.
 */
export async function reloadResources(
  context: ResourceReloadContext,
  targets: readonly ResourceReloadTarget[] = ResourceReloadTargetSchema.options
): Promise<ResourceReloadResult> {
  return createResourceReloader(context).reload(targets);
}

async function reloadTarget(context: ResourceReloadContext, target: ResourceReloadTarget): Promise<ResourceReloadSummary> {
  switch (target) {
    case "skills":
      return reloadSkills(context);
    case "theme":
      return reloadTheme(context);
    case "extensions":
      return reloadExtensions(context);
    default: {
      const exhaustive: never = target;
      return {
        target: target as ResourceReloadTarget,
        ok: false,
        message: `Unknown reload target: ${String(exhaustive)}`,
        count: 0,
        diagnostics: []
      };
    }
  }
}

function reloadSkills(context: ResourceReloadContext): ResourceReloadSummary {
  let snapshot: ResourceReloadSkillsSnapshot;
  try {
    snapshot = {
      catalog: discoverSkills(context.skillLoaderOptions ?? {}),
      diagnostics: []
    };
  } catch (error) {
    return {
      target: "skills",
      ok: false,
      message: `Skill reload failed: ${formatError(error)}`,
      count: 0,
      diagnostics: [formatError(error)]
    };
  }

  const inaccessibleDirectories = snapshot.catalog.diagnostics.filter(
    (diagnostic) => diagnostic.startsWith("Skill directory not found:") || diagnostic.startsWith("Skill path is not a directory:")
  );
  if (inaccessibleDirectories.length > 0) {
    return {
      target: "skills",
      ok: false,
      message: `Skill reload failed: ${inaccessibleDirectories.join("; ")}`,
      count: 0,
      diagnostics: snapshot.catalog.diagnostics
    };
  }

  return {
    target: "skills",
    ok: true,
    message: `Reloaded ${snapshot.catalog.skills.length} skill(s) from ${snapshot.catalog.directories.length} directorie(s).`,
    count: snapshot.catalog.skills.length,
    diagnostics: snapshot.catalog.diagnostics
  };
}

function reloadTheme(context: ResourceReloadContext): ResourceReloadSummary {
  let snapshot: ResourceReloadThemeSnapshot;
  try {
    const result = loadTheme(context.themeFilePath);
    snapshot = {
      tokens: result.tokens,
      name: result.name,
      source: result.source,
      diagnostics: []
    };
  } catch (error) {
    return {
      target: "theme",
      ok: false,
      message: `Theme reload failed: ${formatError(error)}`,
      count: 0,
      diagnostics: [formatError(error)]
    };
  }

  const tokenCount = Object.keys(snapshot.tokens).length;
  return {
    target: "theme",
    ok: true,
    message: `Reloaded theme "${snapshot.name}" from ${snapshot.source} (${tokenCount} tokens).`,
    count: tokenCount,
    diagnostics: snapshot.diagnostics
  };
}

function reloadExtensions(context: ResourceReloadContext): ResourceReloadSummary {
  const host = context.extensionHost;
  if (!host) {
    return {
      target: "extensions",
      ok: false,
      message: "Extension host not provided; cannot reload extensions.",
      count: 0,
      diagnostics: ["No extension host in reload context."]
    };
  }

  let snapshot: ResourceReloadExtensionsSnapshot;
  try {
    host.start();
    snapshot = {
      commands: host.getCommandRegistry().size,
      routes: host.getRouteRegistry().length,
      toolFactories: host.getToolFactories().length,
      diagnostics: []
    };
  } catch (error) {
    return {
      target: "extensions",
      ok: false,
      message: `Extension reload failed: ${formatError(error)}`,
      count: 0,
      diagnostics: [formatError(error)]
    };
  }

  return {
    target: "extensions",
    ok: true,
    message: `Reloaded extensions: ${snapshot.commands} command(s), ${snapshot.routes} route(s), ${snapshot.toolFactories} tool factory(ies).`,
    count: snapshot.commands + snapshot.routes + snapshot.toolFactories,
    diagnostics: snapshot.diagnostics
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
