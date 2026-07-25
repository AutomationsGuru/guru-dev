/**
 * Tool-result compaction strategy (IDEA-F249 / R-MA-TOOL-COMPACT).
 *
 * Pure, deterministic reducer over a flat message history. When a tool-result
 * payload exceeds a character threshold, the oldest such payloads are replaced
 * with a short summary stub so context pressure drops without calling a model.
 * This is the strategy primitive only — it does NOT wire into the compaction
 * engine or agent loop; integration is a downstream seam owner's work.
 *
 * Ideation source: microsoft-agent-framework ToolResultCompactionStrategy residual,
 * adapted to GuruHarness's flat ChatTurnMessage-style history. Composes with the
 * F244 summarizer and F211 offload lanes.
 *
 * Design notes:
 * - Model-free: no provider call, no estimator, no new runtime dependency.
 * - Preserve-then-replace: input array and messages are never mutated; compacted
 *   entries are new objects.
 * - Keep-recent: the newest `keepRecentCount` tool results stay verbatim so the
 *   loop always sees its latest tool output in full.
 * - Structural role match: `role` is a plain string so this accepts both the
 *   flat `ChatTurnMessage` ("system"|"user"|"assistant") and tool-result
 *   messages without importing core types or editing the seam.
 */

/** Minimal structural message — compatible with ChatTurnMessage and tool results. */
export interface CompactionMessage {
  readonly role: string;
  readonly content: string;
}

export interface ToolResultCompactionOptions {
  /**
   * How many of the NEWEST tool-result messages are always kept verbatim,
   * even when oversized. Default 1 so the loop never loses its latest output.
   */
  readonly keepRecentCount?: number;
  /** Characters of the original head preserved inside the summary stub. */
  readonly headChars?: number;
}

/** Default per-tool-result character ceiling before a payload is compacted. */
export const DEFAULT_MAX_TOOL_CHARS = 4000;
const DEFAULT_KEEP_RECENT = 1;
const DEFAULT_HEAD_CHARS = 120;

/** Roles treated as tool results. "tool" is the OpenAI/Anthropic tool-result role. */
const TOOL_RESULT_ROLES: ReadonlySet<string> = new Set(["tool", "toolResult", "tool_result"]);

function isToolResult(message: CompactionMessage): boolean {
  return TOOL_RESULT_ROLES.has(message.role);
}

/** Build the deterministic summary stub replacing an oversized payload. */
function buildStub(original: string, headChars: number): string {
  const head = original.slice(0, Math.max(0, headChars));
  return (
    `[tool result compacted — ${original.length} chars omitted]\n` +
    `${head}\n` +
    `[… ${original.length - head.length} more chars compacted]`
  );
}

/**
 * Replace OLD oversized tool results with short summary stubs.
 *
 * A message is compacted only when ALL hold:
 *   - its role is a tool-result role,
 *   - its content length is STRICTLY greater than maxToolChars,
 *   - it is not among the newest `keepRecentCount` tool results.
 *
 * Everything else is returned by reference, unchanged. The returned array is new;
 * input is never mutated.
 */
export function compactToolResults(
  messages: readonly CompactionMessage[],
  maxToolChars: number = DEFAULT_MAX_TOOL_CHARS,
  options: ToolResultCompactionOptions = {}
): CompactionMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const keepRecentCount = options.keepRecentCount ?? DEFAULT_KEEP_RECENT;
  const headChars = options.headChars ?? DEFAULT_HEAD_CHARS;

  // Indices of tool-result messages, oldest → newest.
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (isToolResult(messages[i]!)) {
      toolIndices.push(i);
    }
  }

  // The newest `keepRecentCount` tool results are protected from compaction.
  const protectedStart = Math.max(0, toolIndices.length - Math.max(0, keepRecentCount));
  const protectedIndices = new Set(toolIndices.slice(protectedStart));

  const out: CompactionMessage[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    const oversized = message.content.length > maxToolChars;
    if (isToolResult(message) && oversized && !protectedIndices.has(i)) {
      out[i] = { role: message.role, content: buildStub(message.content, headChars) };
    } else {
      out[i] = message; // unchanged by reference
    }
  }
  return out;
}
