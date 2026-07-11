import { LookAheadConfigSchema, type BranchNode, type CommitStepObservation, type LookAheadConfig, type LookAheadStats, type MatchResult } from "./schema.js";

/**
 * LookAheadEngine v1 — the two-plane commit/scout engine (ADR
 * 2026-07-04-lookahead-engine-v1). Pure orchestration over an INJECTED scout
 * spawner (the read-only swarm) and an INJECTED fork enumerator (the pending
 * step's failure surface + garage priors). The commit plane drives; the engine
 * only ever pre-explores in dead time and offers warm hints — it never mutates
 * and never blocks the commit plane.
 */

export interface ScoutSpawn {
  /** Spawn a READ-ONLY scout to pre-explore a fork; returns its task id. */
  (fork: { triggerCondition: string; prompt: string }): { taskId: string };
}

export interface ForkEnumerator {
  /** Top-K likely forks of the pending step (from failure surface + garage priors). */
  (pendingToolId: string, k: number): ReadonlyArray<{ triggerCondition: string; prompt: string }>;
}

export interface LookAheadEngineOptions {
  readonly config?: Partial<LookAheadConfig>;
  readonly spawnScout: ScoutSpawn;
  readonly enumerateForks: ForkEnumerator;
  /** Records a resolved fork to the garage (path-outcome learning). Optional. */
  readonly onBranchResolved?: (event: { pendingToolId: string; outcome: "hit" | "miss"; triggerCondition?: string }) => void;
}

export interface LookAheadEngine {
  readonly config: LookAheadConfig;
  /** Session-scoped enable flag (config default; overridable via /lookahead on|off). */
  readonly enabled: boolean;
  /** Toggle scouts for the rest of this guru session without editing config. */
  setEnabled(enabled: boolean): void;
  /**
   * Called when the commit plane is about to block on a tool result (DEAD TIME):
   * pre-explore the pending step's forks with read-only scouts. No-op when
   * disabled or when the commit plane is not in dead time.
   */
  scoutPendingStep(pendingToolId: string, options?: { inDeadTime?: boolean }): readonly BranchNode[];
  /** Called with the REAL result: HIT promotes a scout's plan as a warm hint; MISS degrades. */
  matchBranch(observation: CommitStepObservation): MatchResult;
  /** Open branches currently held (for observability). */
  openBranches(): readonly BranchNode[];
  /** Governor counters (session-scoped: budget spent, hit/miss, throttle state). */
  stats(): LookAheadStats;
  /** Clears branches (new pending step / turn boundary). Governor counters persist. */
  reset(): void;
}

export function createLookAheadEngine(options: LookAheadEngineOptions): LookAheadEngine {
  const config = LookAheadConfigSchema.parse(options.config ?? {});
  let branches: BranchNode[] = [];
  let counter = 0;
  // Governor state — SESSION-scoped (survives per-turn reset()).
  const allowlist = new Set(config.idempotentAllowlist);
  let scoutsSpawned = 0;
  let hits = 0;
  let misses = 0;
  let throttled = false;
  let lastSkip = "";
  let sessionEnabled = config.enabled;

  const engine: LookAheadEngine = {
    config,
    get enabled() {
      return sessionEnabled;
    },
    setEnabled(enabled: boolean) {
      sessionEnabled = enabled;
    },

    scoutPendingStep(pendingToolId, opts) {
      // The law: scouts run ONLY when enabled AND the commit plane is in dead time.
      if (!sessionEnabled || opts?.inDeadTime !== true) {
        return [];
      }
      // Governor gate 1 — miss-rate throttle: speculation stopped paying off.
      if (throttled) {
        lastSkip = `throttled — miss rate over ${Math.round(config.missRateThreshold * 100)}%`;
        return [];
      }
      // Governor gate 2 — idempotency allowlist (default NOTHING): never speculate
      // a step the operator hasn't explicitly trusted as idempotent.
      if (!allowlist.has(pendingToolId)) {
        lastSkip = `"${pendingToolId}" not in the idempotency allowlist`;
        return [];
      }
      // Governor gate 3 — session scout budget (hard cap, never a silent overrun).
      const budgetRemaining = config.maxScoutsPerSession - scoutsSpawned;
      if (budgetRemaining <= 0) {
        lastSkip = `session scout budget exhausted (${config.maxScoutsPerSession})`;
        return [];
      }
      lastSkip = "";
      const width = Math.min(config.forkWidth, budgetRemaining);
      const allForks = options.enumerateForks(pendingToolId, config.forkWidth);
      const forks = allForks.slice(0, width);
      if (forks.length < Math.min(config.forkWidth, allForks.length)) {
        lastSkip = `capped by budget (${budgetRemaining} scout(s) left this session)`;
      }
      const fresh: BranchNode[] = [];
      for (const fork of forks) {
        const spawn = options.spawnScout(fork); // read-only scout, by contract
        scoutsSpawned += 1;
        const node: BranchNode = {
          id: `branch-${(counter += 1)}`,
          triggerCondition: fork.triggerCondition,
          precomputedPlan: fork.prompt,
          scoutTaskId: spawn.taskId,
          state: "open"
        };
        branches.push(node);
        fresh.push(node);
      }
      return fresh;
    },

    matchBranch(observation) {
      const haystack = `${observation.status} ${observation.toolId} ${observation.detail ?? ""}`.toLowerCase();
      const hit = branches.find((branch) => {
        if (branch.state !== "open") {
          return false;
        }
        // A trigger matches when its keywords appear in the observed result.
        const keywords = branch.triggerCondition
          .toLowerCase()
          .split(/[^a-z0-9]+/u)
          .filter((token) => token.length > 2);
        const matchedKeywords = keywords.filter((keyword) => haystack.includes(keyword)).length;
        return keywords.length > 0 && matchedKeywords >= Math.ceil(keywords.length / 2);
      });

      if (hit) {
        hit.state = "matched";
        for (const branch of branches) {
          if (branch !== hit && branch.state === "open") {
            branch.state = "pruned";
          }
        }
        hits += 1;
        maybeThrottle();
        options.onBranchResolved?.({ pendingToolId: observation.toolId, outcome: "hit", triggerCondition: hit.triggerCondition });
        return {
          outcome: "hit",
          branch: hit,
          warmHint: `A scout foresaw this fork ("${hit.triggerCondition}") and pre-reasoned a recovery: ${hit.precomputedPlan}. Validate and proceed (any mutation still passes approval).`
        };
      }

      // MISS: degrade silently to the plain loop; log the blind fork for next time.
      for (const branch of branches) {
        if (branch.state === "open") {
          branch.state = "pruned";
        }
      }
      misses += 1;
      maybeThrottle();
      options.onBranchResolved?.({ pendingToolId: observation.toolId, outcome: "miss" });
      return { outcome: "miss" };
    },

    openBranches() {
      return branches.filter((branch) => branch.state === "open");
    },

    stats() {
      const total = hits + misses;
      return {
        scoutsSpawned,
        budgetRemaining: Math.max(0, config.maxScoutsPerSession - scoutsSpawned),
        hits,
        misses,
        missRate: total > 0 ? misses / total : 0,
        throttled,
        lastSkip
      };
    },

    reset() {
      branches = [];
    }
  };

  /** Engage the throttle once enough branches resolved and the miss rate is too high. */
  function maybeThrottle(): void {
    const total = hits + misses;
    if (!throttled && total >= config.minSamplesBeforeThrottle && misses / total > config.missRateThreshold) {
      throttled = true;
    }
  }

  return engine;
}
