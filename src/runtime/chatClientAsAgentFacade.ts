import { z } from "zod";

/**
 * Chat client as agent facade (IDEA-F264-CHAT-AGENT-01 / R-MA-CHAT-AGENT).
 *
 * Microsoft Agent Framework can adapt an IChatClient into an AIAgent via
 * AsAIAgent({ name, instructions, tools }). This module is the Guru-native
 * counterpart: a thin, pure mapping from that chat-client options shape to a
 * Guru agent config — no .NET/Python runtime, no framework rehost, no
 * orchestration SDK underneath. The mapped config is plain data; starting or
 * running a session stays with the owned runtime.
 */

export const ChatClientAgentToolSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().min(1).optional()
  })
  .strict();
export type ChatClientAgentTool = z.infer<typeof ChatClientAgentToolSchema>;

export const ChatClientAgentOptionsSchema = z
  .object({
    name: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    tools: z.array(ChatClientAgentToolSchema).default([]),
    model: z.string().trim().min(1).optional()
  })
  .strict();
export type ChatClientAgentOptions = z.input<typeof ChatClientAgentOptionsSchema>;

/**
 * The Guru-side agent config produced by the facade. `instructions` maps to
 * the runtime's existing systemPrompt concept; `tools` maps to tool ids that a
 * session/registry resolves into real ToolDefinitions at start time.
 */
export const GuruAgentConfigSchema = z
  .object({
    name: z.string().trim().min(1),
    systemPrompt: z.string().trim().min(1),
    toolIds: z.array(z.string().trim().min(1)),
    model: z.string().trim().min(1).optional(),
    source: z.literal("chat-client-agent-facade")
  })
  .strict();
export type GuruAgentConfig = z.infer<typeof GuruAgentConfigSchema>;

/** map(options): chat-client agent options → Guru agent config. */
export function mapChatClientToGuruAgentConfig(options: ChatClientAgentOptions): GuruAgentConfig {
  const parsed = ChatClientAgentOptionsSchema.parse(options);
  const config: GuruAgentConfig = {
    name: parsed.name,
    systemPrompt: parsed.instructions,
    toolIds: parsed.tools.map((tool) => tool.id),
    source: "chat-client-agent-facade"
  };
  if (parsed.model !== undefined) {
    config.model = parsed.model;
  }
  return config;
}
