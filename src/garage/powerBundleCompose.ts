import type {
  PowerBundle,
  PowerMcpServerEntry,
  SteeringDescriptor,
  HookRegistration
} from "./powerBundleComposeSchema.js";
import { PowerBundleSchema } from "./powerBundleComposeSchema.js";

/**
 * Power Bundle Compose — offline validation, install planning, conflict
 * detection, and composition of power bundles (IDEA-F141).
 *
 * Every function here is pure: no filesystem access, no network fetch, no
 * side effects. Validation happens through the Zod schema; planInstall
 * produces a dry-run plan of what would be installed where; conflict
 * detection compares bundles for overlapping registrations before install.
 */

// -- validate ---------------------------------------------------------------

export interface ValidateResult {
  readonly ok: boolean;
  readonly bundle: PowerBundle | null;
  readonly errors: readonly string[];
}

/** Parse and validate an unknown input as a PowerBundle. */
export function validatePowerBundle(input: unknown): ValidateResult {
  const parsed = PowerBundleSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, bundle: parsed.data, errors: [] };
  }
  const errors = parsed.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`
  );
  return { ok: false, bundle: null, errors };
}

// -- planInstall ------------------------------------------------------------

/** A single planned install path — what would be written where. */
export interface InstallPlanEntry {
  readonly component: "mcp-server" | "steering" | "hook";
  readonly id: string;
  /** Filesystem path (relative to the project root) where this would land. */
  readonly targetPath: string;
  /** The kind of artifact that would be created. */
  readonly artifactKind: "config" | "script" | "manifest-entry";
}

export interface PlanInstallResult {
  readonly bundleId: string;
  readonly entries: readonly InstallPlanEntry[];
}

/**
 * Produce a dry-run install plan for a validated PowerBundle. Every entry
 * describes what would be installed and where — without touching disk,
 * fetching from the network, or connecting to any server.
 *
 * Path conventions:
 *   mcpServers → .guru/mcp/<server-id>.json
 *   steering   → .guru/steering/<steering-id>.json
 *   hooks      → .guru/hooks/<handler>  (script reference)
 */
export function planInstall(bundle: PowerBundle): PlanInstallResult {
  const entries: InstallPlanEntry[] = [];

  for (const server of bundle.mcpServers) {
    entries.push({
      component: "mcp-server",
      id: server.id,
      targetPath: `.guru/mcp/${server.id}.json`,
      artifactKind: server.ref ? "config" : "config"
    });
  }

  for (const steer of bundle.steering) {
    entries.push({
      component: "steering",
      id: steer.id,
      targetPath: `.guru/steering/${steer.id}.json`,
      artifactKind: "config"
    });
  }

  for (const hook of bundle.hooks) {
    entries.push({
      component: "hook",
      id: hook.id,
      targetPath: `.guru/hooks/${hook.handler}`,
      artifactKind: "script"
    });
  }

  return { bundleId: bundle.id, entries };
}

// -- conflict detection -----------------------------------------------------

export interface ConflictEntry {
  readonly kind: "duplicate-mcp-server" | "duplicate-steering" | "duplicate-hook" | "mcp-ref-vs-inline";
  readonly componentA: string;
  readonly componentB: string;
  readonly path: string;
  readonly detail: string;
}

export interface ConflictReport {
  readonly hasConflicts: boolean;
  readonly conflicts: readonly ConflictEntry[];
}

function idSet(entries: ReadonlyArray<{ readonly id: string }>): Set<string> {
  return new Set(entries.map((e) => e.id));
}

/**
 * Detect conflicts across a set of power bundles. Returns every overlapping
 * registration — same MCP server id, same steering rule id, or same hook
 * (event + handler) — so the caller can decide to abort, merge, or override.
 */
export function detectConflicts(bundles: readonly PowerBundle[]): ConflictReport {
  const conflicts: ConflictEntry[] = [];

  for (let i = 0; i < bundles.length; i++) {
    for (let j = i + 1; j < bundles.length; j++) {
      const a = bundles[i]!;
      const b = bundles[j]!;

      // MCP server id conflicts
      const aMcp = idSet(a.mcpServers);
      for (const entry of b.mcpServers) {
        if (aMcp.has(entry.id)) {
          const aEntry = a.mcpServers.find((e) => e.id === entry.id)!;
          const conflictKind =
            aEntry.ref && entry.ref
              ? "duplicate-mcp-server"
              : !aEntry.ref && !entry.ref
                ? "duplicate-mcp-server"
                : "mcp-ref-vs-inline";
          conflicts.push({
            kind: conflictKind,
            componentA: `${a.id}:mcp:${entry.id}`,
            componentB: `${b.id}:mcp:${entry.id}`,
            path: `.guru/mcp/${entry.id}.json`,
            detail: `MCP server "${entry.id}" registered by both "${a.id}" and "${b.id}".`
          });
        }
      }

      // Steering id conflicts
      const aSteer = idSet(a.steering);
      for (const entry of b.steering) {
        if (aSteer.has(entry.id)) {
          conflicts.push({
            kind: "duplicate-steering",
            componentA: `${a.id}:steering:${entry.id}`,
            componentB: `${b.id}:steering:${entry.id}`,
            path: `.guru/steering/${entry.id}.json`,
            detail: `Steering rule "${entry.id}" registered by both "${a.id}" and "${b.id}".`
          });
        }
      }

      // Hook conflicts (same event + same handler)
      const aHookKeys = new Set(a.hooks.map((h) => `${h.event}::${h.handler}`));
      for (const entry of b.hooks) {
        const key = `${entry.event}::${entry.handler}`;
        if (aHookKeys.has(key)) {
          conflicts.push({
            kind: "duplicate-hook",
            componentA: `${a.id}:hook:${entry.id}`,
            componentB: `${b.id}:hook:${entry.id}`,
            path: `.guru/hooks/${entry.handler}`,
            detail: `Hook "${entry.handler}" on event "${entry.event}" registered by both "${a.id}" and "${b.id}".`
          });
        }
      }
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts
  };
}

// -- compose -----------------------------------------------------------------

export interface ComposedPowerBundle {
  readonly bundleIds: readonly string[];
  readonly mcpServers: readonly PowerMcpServerEntry[];
  readonly steering: readonly SteeringDescriptor[];
  readonly hooks: readonly HookRegistration[];
  readonly conflicts: readonly ConflictEntry[];
}

/**
 * Compose multiple power bundles into a single merged manifest. When two
 * bundles register the same component (MCP server id, steering id, or hook
 * event+handler), the conflict is recorded rather than silently overwriting —
 * the caller decides the resolution strategy. The composed result includes
 * both the merged entries (earliest-bundle-wins for conflicting ids) and the
 * full conflict report.
 */
export function composePowerBundles(bundles: readonly PowerBundle[]): ComposedPowerBundle {
  const conflictReport = detectConflicts(bundles);

  const seenMcp = new Set<string>();
  const seenSteer = new Set<string>();
  const seenHook = new Set<string>();

  const mcpServers: PowerMcpServerEntry[] = [];
  const steering: SteeringDescriptor[] = [];
  const hooks: HookRegistration[] = [];

  for (const bundle of bundles) {
    for (const entry of bundle.mcpServers) {
      if (!seenMcp.has(entry.id)) {
        seenMcp.add(entry.id);
        mcpServers.push(entry);
      }
    }
    for (const entry of bundle.steering) {
      if (!seenSteer.has(entry.id)) {
        seenSteer.add(entry.id);
        steering.push(entry);
      }
    }
    for (const entry of bundle.hooks) {
      const key = `${entry.event}::${entry.handler}`;
      if (!seenHook.has(key)) {
        seenHook.add(key);
        hooks.push(entry);
      }
    }
  }

  return {
    bundleIds: bundles.map((b) => b.id),
    mcpServers,
    steering,
    hooks,
    conflicts: conflictReport.conflicts
  };
}
