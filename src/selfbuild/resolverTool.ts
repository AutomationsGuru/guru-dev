import { CapabilityGapSchema, NeverStuckResolutionSchema, resolveCapabilityGap, type ResolverContext } from "./resolver.js";
import type { ToolDefinition } from "../tools/registry.js";

/**
 * Model-facing never-stuck resolver (Phase G). Context is LATE-BOUND by the
 * live session (registered tools + garage capabilities are session state) —
 * the same pattern as the swarm runner. Unbound context still resolves,
 * honestly, from an empty registry.
 */

interface ResolverContextHolder {
  context: ResolverContext | null;
}

const holder: ResolverContextHolder = { context: null };

export function setResolverContext(context: ResolverContext | null): void {
  holder.context = context;
}

export function createResolverTools(): readonly ToolDefinition[] {
  const resolveTool: ToolDefinition<typeof CapabilityGapSchema, typeof NeverStuckResolutionSchema> = {
    id: "resolve_capability_gap",
    title: "Never-stuck resolver",
    description:
      "When you lack a capability, resolve the gap BEFORE improvising: decides BUILD (write it) | ATTACH (drive something already on this machine) | LEARN-REPLICATE (study a program that does it) | already-have. States the move and why; returns a concrete work plan. Pass candidateCommands (CLIs that might do it) and referencePrograms (programs known to do it).",
    inputSchema: CapabilityGapSchema,
    outputSchema: NeverStuckResolutionSchema,
    execute: (input) =>
      resolveCapabilityGap(
        input,
        holder.context ?? { registeredToolIds: new Set<string>(), toolSummaries: new Map<string, string>() }
      )
  };
  return [resolveTool];
}
