import { z } from "zod";

import type { ToolDefinition } from "../tools/registry.js";

/**
 * IDEA-F264 — Chat client as agent facade.
 *
 * The microsoft-agent-framework exposes `AsAIAgent`, which lifts a chat client
 * (a thing that turns messages into messages) into an "agent" by stapling on a
 * name, instructions, and a tool set. Rehosting that runtime would pull a .NET/
 * foreign dependency into core (ceiling drift, §1.1). GuruHarness already owns
 * its own agent runtime (`model/agentTurn`), so this facade does only the
 * *mapping* — it normalizes the high-level `{name, instructions, tools}` options
 * into a Guru agent config with no foreign runtime attached.
 *
 * The mapping is a pure, synchronous transform. It builds:
 *   - a system prompt that names the agent and carries its instructions, and
 *   - a coerced, de-duplicated, defensively-copied tools list.
 *
 * Nothing here executes the loop, calls a provider, or imports an SDK. The
 * returned config is consumed by the owned runtime at call sites that opt in.
 */

/** High-level chat-client-style options, modelled on the MAF `AsAIAgent` shape. */
export interface ChatClientAsAgentOptions {
  /** Human-facing agent identity; included in the system prompt header. */
  readonly name?: string;
  /** Free-form operating instructions folded into the system prompt body. */
  readonly instructions?: string;
  /** Tools the agent may call. Coerced to owned `ToolDefinition` shape. */
  readonly tools?: readonly (ToolDefinition | ChatClientToolLike)[];
}

/**
 * A tool described the way a chat client describes one — name + description plus
 * an optional schema. This is the loose shape callers arrive with; the facade
 * normalizes it into a strict `ToolDefinition` for the owned runtime.
 */
export interface ChatClientToolLike {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: ToolDefinition["inputSchema"];
}

/** The Guru agent config this facade produces. */
export interface ChatClientAsAgentConfig {
  /** Agent name as resolved from options (defaults to "agent"). */
  readonly name: string;
  /** Fully assembled system prompt: name header + instructions body. */
  readonly systemPrompt: string;
  /** Owned tool definitions, de-duplicated by id, in option order. */
  readonly tools: readonly ToolDefinition[];
}

const DEFAULT_AGENT_NAME = "agent";

/**
 * Resolve the agent name from options. An empty/whitespace name falls back to
 * the default so downstream consumers never receive an empty identity.
 */
function resolveName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_AGENT_NAME;
}

/**
 * Assemble the system prompt. The name is always present as a header; the
 * instructions body is appended only when supplied, preserving the caller's
 * formatting (no rewrapping — instructions are operator-authored prose).
 */
function buildSystemPrompt(name: string, instructions: string | undefined): string {
  const header = `You are ${name}.`;
  const body = instructions?.trim();
  return body && body.length > 0 ? `${header}\n\n${body}` : header;
}

/**
 * Coerce a single option tool into an owned `ToolDefinition`. Owned definitions
 * pass through by identity; chat-client-shaped tools are normalized. A tool
 * without a usable id (and no name) is dropped — the owned registry rejects
 * id-less tools, and silently dropping a mis-described tool would hide a parity
 * gap, so the facade surfaces nothing rather than a malformed half-definition.
 */
function coerceTool(tool: ToolDefinition | ChatClientToolLike): ToolDefinition | undefined {
  // An already-owned tool definition passes straight through (it has an input
  // schema and an executable body). Match on both signals so a chat-client tool
  // that happens to carry an inputSchema but no execute is still normalized.
  if ("execute" in tool && typeof (tool as { execute?: unknown }).execute === "function") {
    return tool as ToolDefinition;
  }
  const like = tool as ChatClientToolLike;
  const id = (like.id ?? like.name ?? "").trim();
  if (id.length === 0) {
    return undefined;
  }
  const description = (like.description ?? "").trim();
  // Chat-client-shaped tools describe capability but carry no executable body in
  // the owned runtime; the consumer wires the real executeTool. Permissive zod
  // schemas keep the definition registry-ready.
  const owned: ToolDefinition = {
    id,
    title: (like.title ?? id).trim(),
    description,
    inputSchema: like.inputSchema ?? z.object({}).passthrough(),
    outputSchema: z.unknown(),
    execute: async () => {
      throw new Error(
        `Chat-client tool "${id}" has no owned execute implementation; wire it via the agent runtime's executeTool.`
      );
    }
  };
  return owned;
}

/**
 * De-duplicate coerced tools by id, preserving first-seen order. Duplicate tool
 * ids would throw at registry time; the facade resolves the collision here so
 * the produced config is always registry-ready.
 */
function dedupeTools(tools: readonly ToolDefinition[]): readonly ToolDefinition[] {
  const seen = new Set<string>();
  const out: ToolDefinition[] = [];
  for (const tool of tools) {
    if (seen.has(tool.id)) {
      continue;
    }
    seen.add(tool.id);
    out.push(tool);
  }
  return out;
}

/**
 * Map chat-client-style agent options to a Guru agent config.
 *
 * Pure and synchronous: no provider calls, no SDK imports, no foreign runtime.
 * Returns a normalized config the owned agent runtime can consume.
 */
export function mapChatClientAsAgent(options: ChatClientAsAgentOptions): ChatClientAsAgentConfig {
  const name = resolveName(options.name);
  const systemPrompt = buildSystemPrompt(name, options.instructions);
  const coerced = (options.tools ?? []).map(coerceTool).filter((t): t is ToolDefinition => t !== undefined);
  const tools = dedupeTools(coerced);
  return { name, systemPrompt, tools };
}
