#!/usr/bin/env node
/**
 * JIT Context Injector (IDEA-F385)
 * Lightweight, registry-driven context injection for agent prompts.
 * Respects token budgets, caches provider results, isolates errors.
 * Part of GuruHarness memory layer.
 */

export interface ContextProvider {
  name: string;
  priority: number; // higher = earlier consideration
  estimateTokens: (ctx: AgentContext) => number;
  fetch: (ctx: AgentContext, signal?: AbortSignal) => Promise<string>;
}

export interface JITConfig {
  maxContextTokens: number;
  cacheTTL: number; // ms
  enableCache?: boolean;
}

export interface AgentContext {
  sessionId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export interface InjectedContext {
  prompt: string;
  injectedTokens: number;
  providersUsed: string[];
  cacheHits: string[];
}

interface CacheEntry {
  content: string;
  tokens: number;
  timestamp: number;
}

export class JITContextInjector {
  private readonly registry = new Map<string, ContextProvider>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly config: Required<JITConfig>;

  constructor(config: JITConfig) {
    this.config = {
      maxContextTokens: config.maxContextTokens,
      cacheTTL: config.cacheTTL,
      enableCache: config.enableCache ?? true,
    };
  }

  registerProvider(provider: ContextProvider): void {
    if (this.registry.has(provider.name)) {
      throw new Error(`Provider ${provider.name} already registered`);
    }
    this.registry.set(provider.name, provider);
  }

  unregisterProvider(name: string): void {
    this.registry.delete(name);
    // Invalidate related cache entries
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${name}:`)) {
        this.cache.delete(key);
      }
    }
  }

  async injectContext(
    prompt: string,
    context: AgentContext
  ): Promise<InjectedContext> {
    const signal = context.abortSignal;
    const budget = this.config.maxContextTokens;
    let remaining = budget;
    const sections: string[] = [];
    const providersUsed: string[] = [];
    const cacheHits: string[] = [];
    let totalInjected = 0;

    // Collect and sort providers by priority desc
    const providers = Array.from(this.registry.values()).sort(
      (a, b) => b.priority - a.priority
    );

    for (const provider of providers) {
      if (signal?.aborted) {
        break;
      }

      const cacheKey = `${provider.name}:${context.sessionId}`;
      let content: string;
      let tokens: number;
      let fromCache = false;

      const cached = this.cache.get(cacheKey);
      const now = Date.now();

      if (
        this.config.enableCache &&
        cached &&
        now - cached.timestamp < this.config.cacheTTL
      ) {
        content = cached.content;
        tokens = cached.tokens;
        fromCache = true;
        cacheHits.push(provider.name);
      } else {
        try {
          content = await provider.fetch(context, signal);
          tokens = provider.estimateTokens(context);
          if (this.config.enableCache) {
            this.cache.set(cacheKey, {
              content,
              tokens,
              timestamp: now,
            });
          }
        } catch (err) {
          // Error isolation: skip failing provider, continue
          continue;
        }
      }

      if (tokens > remaining) {
        // Truncate to fit budget (simple char-based for minimal impl)
        const ratio = remaining / tokens;
        content = content.slice(0, Math.floor(content.length * ratio));
        tokens = remaining;
      }

      if (tokens > 0) {
        sections.push(`<!-- CONTEXT:${provider.name} -->\n${content}`);
        providersUsed.push(provider.name);
        totalInjected += tokens;
        remaining -= tokens;
      }

      if (remaining <= 0) {
        break;
      }
    }

    let finalPrompt = prompt;
    const marker = '<!-- JIT_CONTEXT -->';
    const injection = sections.join('\n\n');

    if (prompt.includes(marker)) {
      finalPrompt = prompt.replace(marker, injection);
    } else if (injection) {
      finalPrompt = `${prompt}\n\n${injection}`;
    }

    return {
      prompt: finalPrompt,
      injectedTokens: totalInjected,
      providersUsed,
      cacheHits,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
