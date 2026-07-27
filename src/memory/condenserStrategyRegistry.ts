/**
 * Condenser Strategy Registry for GuruHarness memory management.
 *
 * Provides a registry for pure condenser strategies that transform message arrays
 * to fit within context token budgets. Aligns with VISION.md emphasis on
 * condensers for reliable long-running agent memory and context window control.
 *
 * All strategies are pure functions: no side effects, no mutation of inputs,
 * budget param stubbed (no real tokenization yet).
 */

export interface Message {
  role: string;
  content: string | null;
  [key: string]: unknown;
}

export type StrategyFn = (messages: Message[], maxTokens: number) => Message[];

/** Internal registry map: id -> strategy function */
const registry = new Map<string, StrategyFn>();

/**
 * Register a new condenser strategy.
 * @param id - unique string identifier (e.g. "drop-oldest")
 * @param fn - pure (messages, maxTokens) => messages function
 */
export function registerStrategy(id: string, fn: StrategyFn): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Strategy id must be a non-empty string");
  }
  if (typeof fn !== "function") {
    throw new Error("Strategy must be a function");
  }
  if (registry.has(id)) {
    // allow re-register for flexibility, but warn in real would log
  }
  registry.set(id, fn);
}

/**
 * Apply a registered strategy to condense the messages.
 * @param id - the strategy id to dispatch to
 * @param messages - input messages (will not be mutated)
 * @param maxTokens - target budget (stubbed, used as proxy for now)
 * @returns new messages array after condensation
 * @throws Error if unknown id, listing registered ones
 */
export function applyStrategy(
  id: string,
  messages: Message[],
  maxTokens: number
): Message[] {
  const fn = registry.get(id);
  if (!fn) {
    const registered = listStrategies().join(", ") || "none";
    throw new Error(`Unknown condenser strategy: ${id}. Registered: ${registered}`);
  }
  // Pass a shallow copy to ensure purity (strategy should not mutate anyway)
  return fn([...messages], maxTokens);
}

/**
 * List all registered strategy ids, sorted alphabetically.
 */
export function listStrategies(): string[] {
  return Array.from(registry.keys()).sort();
}

// -----------------------------------------------------------------------------
// Built-in pure strategies (registered at module load time)
// -----------------------------------------------------------------------------

/**
 * drop-oldest: Preserve leading system message if present, drop oldest
 * (earliest non-system) messages to fit rough budget proxy.
 * Stub: keeps up to maxTokens/100 messages from the tail (newest).
 */
function dropOldestStrategy(messages: Message[], maxTokens: number): Message[] {
  if (messages.length === 0) return messages;

  const hasSystemFirst = messages[0]?.role === "system";
  const systemPart = hasSystemFirst ? [messages[0]] : [];
  const nonSystem = hasSystemFirst ? messages.slice(1) : messages;

  // Stub budget proxy: assume ~100 tokens per message avg for rough count
  const maxKeep = Math.max(1, Math.floor(maxTokens / 100));
  const keptTail = nonSystem.slice(-maxKeep);

  return [...systemPart, ...keptTail];
}

/**
 * summarize-tail: Keep system prefix, retain head of conversation,
 * replace oldest tail with a single stub summary message.
 * Pure stub summary (no LLM call, just truncated concat).
 */
function summarizeTailStrategy(messages: Message[], maxTokens: number): Message[] {
  if (messages.length <= 3) return messages; // too short to summarize

  const hasSystemFirst = messages[0]?.role === "system";
  const systemPart = hasSystemFirst ? [messages[0]] : [];
  const nonSystem = hasSystemFirst ? messages.slice(1) : messages;

  // Keep some head + summary of tail; simple split
  const tailLen = Math.min(5, Math.floor(nonSystem.length * 0.6));
  const head = nonSystem.slice(0, -tailLen);
  const tail = nonSystem.slice(-tailLen);

  const summaryContent =
    `[STUB SUMMARY of ${tail.length} older messages: ` +
    tail
      .map((m) => `${m.role}:${(m.content || "").substring(0, 80)}`)
      .join(" | ") +
    " ...]";

  const summaryMsg: Message = {
    role: "system",
    content: summaryContent,
    _condensed: true,
    _originalCount: tail.length,
  };

  return [...systemPart, ...head, summaryMsg];
}

/**
 * keep-system: Retains ONLY messages with role === "system".
 * Useful for minimal context resets or system-only mode.
 */
function keepSystemStrategy(messages: Message[], maxTokens: number): Message[] {
  return messages.filter((m) => m.role === "system");
}

// Register built-ins immediately on module load (pure, no I/O)
registerStrategy("drop-oldest", dropOldestStrategy);
registerStrategy("summarize-tail", summarizeTailStrategy);
registerStrategy("keep-system", keepSystemStrategy);

// Export the strategy fns for direct testing or extension
export { dropOldestStrategy, summarizeTailStrategy, keepSystemStrategy };
