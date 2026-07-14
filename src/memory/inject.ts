import { MEMORY_INDEX_LINE_CAP, type FileMemoryStore } from "./store.js";
import type { MemoryFactEntry } from "./store.js";
import type { MemoryScope, ScopedStore } from "./scopes.js";
import { buildRecallIndex, queryRecall, tokenizeRecall } from "./recall.js";
import { loadLearnings } from "../garage/flywheelStore.js";
import { rankForInjection, type InjectionBudget, type Learning } from "../garage/flywheel.js";

/**
 * Boot injection — the load-bearing recall mechanism (push beats pull; §7). The
 * derived index lines are appended to the system prompt at session start so the
 * model KNOWS what it knows without being asked to look. The knowledge flywheel
 * (§8) adds a DECAY-RANKED learnings section: typed learnings are excluded from
 * the flat index and injected by score (confidence × citations ÷ age), with
 * provenance — replacing the old updatedAt dump. The injected ids are returned so
 * the caller can CITE the ones the session then uses.
 */

const DEFAULT_LEARNING_BUDGET: InjectionBudget = { maxLines: 8, maxChars: 1400 };

export interface BootMemoryInjection {
  readonly block: string;
  readonly injectedLearningIds: readonly string[];
}

export interface BootInjectionOptions {
  readonly now?: () => Date;
  /** Task hint terms for task-scoped ranking (empty at cold boot). */
  readonly taskTerms?: ReadonlySet<string>;
  readonly budget?: InjectionBudget;
  /**
   * Smart Connections (§7): the current turn's text. When present, general facts
   * are ranked by BM25 RELEVANCE to it (matched first, then recency fills the
   * budget) and its terms seed the learnings task-boost. Absent → recency only.
   */
  readonly query?: string;
}

export function buildBootMemoryInjection(store: FileMemoryStore, options: BootInjectionOptions = {}): BootMemoryInjection {
  const now = options.now ?? (() => new Date());
  // General facts (everything except the flywheel's learnings), newest first.
  const general = store
    .list()
    .filter((entry) => entry.fact.type !== "learning")
    .slice(0, MEMORY_INDEX_LINE_CAP)
    .map((entry) => `- [${entry.fact.title}](${entry.fact.name}.md) — ${entry.fact.description}`);

  // Decay-ranked learnings (the flywheel's INJECT stage).
  const ranked = rankForInjection(loadLearnings(store), {
    now: now(),
    ...(options.taskTerms ? { taskTerms: options.taskTerms } : {}),
    budget: options.budget ?? DEFAULT_LEARNING_BUDGET
  });
  const learningLines = ranked.map(
    (learning) => `- (${learning.level}·cited ${learning.citations.length}×) ${learning.statement}`
  );

  if (general.length === 0 && learningLines.length === 0) {
    return { block: "", injectedLearningIds: [] };
  }
  const sections: string[] = [""];
  if (general.length > 0) {
    sections.push("## Guru memory (point-in-time facts — verify stale facts against current state; read bodies with memory_get)", ...general);
  }
  if (learningLines.length > 0) {
    sections.push("", "## Guru learned (decay-ranked — these compound as you cite them by using them)", ...learningLines);
  }
  return { block: sections.join("\n"), injectedLearningIds: ranked.map((learning) => learning.id) };
}

/** Back-compat string-only form (the block without the injected-id tracking). */
export function buildBootMemoryBlock(store: FileMemoryStore): string {
  return buildBootMemoryInjection(store).block;
}

/**
 * Provider-neutral fact injection used when PostgreSQL is selected. Learnings
 * remain in Guru's local garage/flywheel store; this function intentionally owns
 * only the user-visible durable facts that can live in Markdown or PostgreSQL.
 */
export function buildFactMemoryInjection(entries: readonly MemoryFactEntry[], options: Pick<BootInjectionOptions, "query"> = {}): BootMemoryInjection {
  const facts = entries.filter((entry) => entry.fact.type !== "learning");
  const byRecency = [...facts];
  let selected = byRecency;
  const query = options.query?.trim() ?? "";
  if (query.length > 0 && facts.length > 0) {
    const index = buildRecallIndex(facts.map((entry) => ({ id: entry.fact.name, text: `${entry.fact.title} ${entry.fact.description}` })));
    const matchingNames = queryRecall(index, query).map((hit) => hit.id);
    const matched = new Set(matchingNames);
    const byName = new Map(facts.map((entry) => [entry.fact.name, entry]));
    selected = [
      ...matchingNames.flatMap((name) => {
        const entry = byName.get(name);
        return entry ? [entry] : [];
      }),
      ...facts.filter((entry) => !matched.has(entry.fact.name))
    ];
  }
  const lines = selected
    .slice(0, MEMORY_INDEX_LINE_CAP)
    .map((entry) => `- [${entry.fact.title}](${entry.fact.name}.md) — ${entry.fact.description}`);
  if (lines.length === 0) {
    return { block: "", injectedLearningIds: [] };
  }
  return {
    block: ["", "## Guru memory (point-in-time facts — verify stale facts against current state; read bodies with memory_get)", ...lines].join("\n"),
    injectedLearningIds: []
  };
}

/** A short scope tag for injected lines (global is unlabeled — it's the floor). */
function scopeTag(scope: MemoryScope): string {
  return scope === "global" ? "" : `  ·${scope}`;
}

/**
 * Multi-scope boot injection (Memory Scopes wave, §7). Unions the general facts
 * and the decay-ranked learnings across the ACTIVE scopes (global ▸ space ▸ role),
 * tagging each line with its scope and deduping MOST-SPECIFIC-WINS: a role fact
 * shadows a same-named space fact shadows a same-named global fact. Learnings from
 * every scope are ranked together against one budget so the strongest surface
 * regardless of scope. Returns the merged block + the injected learning ids.
 */
export function mergeScopedBootInjection(stores: readonly ScopedStore[], options: BootInjectionOptions = {}): BootMemoryInjection {
  const now = options.now ?? (() => new Date());

  // General facts, deduped by name most-specific-wins (later = more specific).
  const factByName = new Map<string, { line: string; order: number; text: string }>();
  let order = 0;
  const learnings: Learning[] = [];
  const seenLearning = new Set<string>();
  for (const { scope, store } of stores) {
    for (const entry of store.list()) {
      if (entry.fact.type === "learning") {
        continue;
      }
      factByName.set(entry.fact.name, {
        line: `- [${entry.fact.title}](${entry.fact.name}.md) — ${entry.fact.description}${scopeTag(scope)}`,
        order: order++,
        text: `${entry.fact.title} ${entry.fact.description}`
      });
    }
    for (const learning of loadLearnings(store)) {
      // One malformed learning (hand-edited frontmatter, a bad date string) must
      // never blank ALL boot memory — it used to throw through to the blunt catch
      // in refreshBootMemoryBlock that wipes every fact for the session. Skip the
      // single bad learning instead (review 2026-07-08).
      try {
        if (!seenLearning.has(learning.id)) {
          seenLearning.add(learning.id);
          learnings.push(learning);
        }
      } catch {
        continue;
      }
    }
  }
  // Smart Connections (§7): with a query, order facts by BM25 RELEVANCE (matched
  // first, best score first), then let recency fill the remaining budget. Without
  // a query, pure recency (newest first) — the cold-boot behavior, unchanged.
  const query = options.query?.trim() ?? "";
  const byRecency = [...factByName.keys()].sort((left, right) => (factByName.get(right)?.order ?? 0) - (factByName.get(left)?.order ?? 0));
  let orderedNames = byRecency;
  if (query.length > 0 && factByName.size > 0) {
    const index = buildRecallIndex([...factByName.entries()].map(([id, value]) => ({ id, text: value.text })));
    const matched = queryRecall(index, query).map((hit) => hit.id);
    const matchedSet = new Set(matched);
    orderedNames = [...matched, ...byRecency.filter((name) => !matchedSet.has(name))];
  }
  const general = orderedNames
    .slice(0, MEMORY_INDEX_LINE_CAP)
    .map((name) => factByName.get(name)?.line ?? "");

  // Seed the learnings' task-boost from the query when explicit taskTerms weren't given.
  const taskTerms = options.taskTerms ?? (query.length > 0 ? new Set(tokenizeRecall(query)) : undefined);
  const ranked = rankForInjection(learnings, {
    now: now(),
    ...(taskTerms ? { taskTerms } : {}),
    budget: options.budget ?? DEFAULT_LEARNING_BUDGET
  });
  const learningLines = ranked.map(
    (learning) => `- (${learning.level}·cited ${learning.citations.length}×) ${learning.statement}${learning.scope === "global" ? "" : `  ·${learning.scope}`}`
  );

  if (general.length === 0 && learningLines.length === 0) {
    return { block: "", injectedLearningIds: [] };
  }
  const sections: string[] = [""];
  if (general.length > 0) {
    sections.push("## Guru memory (point-in-time facts — verify stale facts against current state; read bodies with memory_get)", ...general);
  }
  if (learningLines.length > 0) {
    sections.push("", "## Guru learned (decay-ranked — these compound as you cite them by using them)", ...learningLines);
  }
  return { block: sections.join("\n"), injectedLearningIds: ranked.map((learning) => learning.id) };
}
