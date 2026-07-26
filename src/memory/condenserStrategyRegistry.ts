import { Message } from './types.js';

export type CondenserStrategy = (messages: Message[], maxTokens: number) => Message[];

const registry = new Map<string, CondenserStrategy>();

export function registerStrategy(id: string, fn: CondenserStrategy): void {
  registry.set(id, fn);
}

export function applyStrategy(id: string, messages: Message[], maxTokens: number): Message[] {
  const strategy = registry.get(id);
  if (!strategy) {
    throw new Error(`Unknown condenser strategy: ${id}`);
  }
  return strategy(messages, maxTokens);
}

export function listStrategies(): string[] {
  return Array.from(registry.keys()).sort();
}

// Stub token estimator (real token counting deferred)
function estimateTokens(message: Message): number {
  const content = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content || '');
  return Math.ceil(content.length / 4) + 10;
}

// drop-oldest: preserve all system messages and as many recent non-system messages as fit in budget; drops oldest non-system first
function dropOldest(messages: Message[], maxTokens: number): Message[] {
  if (messages.length === 0) return [];
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  if (totalTokens <= maxTokens) return [...messages];

  const systems = messages.filter(m => m.role === 'system');
  const nonSystemIndices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role !== 'system') nonSystemIndices.push(i);
  });

  let currentTotal = systems.reduce((s, m) => s + estimateTokens(m), 0);
  let startNonSys = 0;
  for (let i = nonSystemIndices.length - 1; i >= 0; i--) {
    const idx = nonSystemIndices[i];
    const t = estimateTokens(messages[idx]);
    if (currentTotal + t > maxTokens) {
      startNonSys = i + 1;
      break;
    }
    currentTotal += t;
  }

  const keepNonSysIdxSet = new Set(nonSystemIndices.slice(startNonSys));
  return messages.filter((m, i) => m.role === 'system' || keepNonSysIdxSet.has(i));
}

// keep-system: return only system messages (trimmed to budget if needed)
function keepSystem(messages: Message[], maxTokens: number): Message[] {
  const systems = messages.filter(m => m.role === 'system');
  let total = 0;
  const kept: Message[] = [];
  for (const sys of systems) {
    const t = estimateTokens(sys);
    if (total + t > maxTokens && kept.length > 0) break;
    kept.push(sys);
    total += t;
  }
  return kept;
}

// summarize-tail: keep systems + recent tail messages; replace older non-system messages with a stub summary message
function summarizeTail(messages: Message[], maxTokens: number): Message[] {
  const systems = messages.filter(m => m.role === 'system');
  const nonSystems = messages.filter(m => m.role !== 'system');
  if (nonSystems.length === 0) return [...systems];

  const sysTokens = systems.reduce((s, m) => s + estimateTokens(m), 0);
  const remaining = Math.max(0, maxTokens - sysTokens);
  const recentCount = Math.max(2, Math.floor(remaining / 200));
  const recent = nonSystems.slice(-recentCount);
  const older = nonSystems.slice(0, -recentCount);

  const result: Message[] = [...systems];
  if (older.length > 0) {
    const summaryText = `[Summary of earlier conversation: ${older.length} messages condensed for token budget. Conversation history continues.]`;
    result.push({ role: 'system', content: summaryText } as Message);
  }
  result.push(...recent);
  return result;
}

// Register built-in strategies at module load
registerStrategy('drop-oldest', dropOldest);
registerStrategy('summarize-tail', summarizeTail);
registerStrategy('keep-system', keepSystem);
