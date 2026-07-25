import type { Summarizer } from "../compaction/engine.js";
import type { ChatTurnMessage } from "../model/directChat.js";
import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * CrossAgentSessionContext (R-XCTX-01, agent-squad ideation review R-AS-XCTX):
 * the session store keeps EVERY agent's turns across agent switches, and the
 * next agent receives shared/summarized context per policy instead of a blank
 * slate. Pure orchestration in the compaction-engine style — no I/O, no wall
 * clock, no network; the "summarized" policy lane runs through an INJECTED
 * Summarizer (the REPL wires the connected route; tests wire a fake).
 *
 * Secret posture mirrors the compaction engine: the transcript block sent to
 * the summarizer is scrubbed, so a resolved credential value never crosses the
 * summary lane.
 */

export type CrossAgentContextMode = "full" | "summarized" | "none";

export interface CrossAgentContextPolicy {
  /**
   * How much of the OTHER agents' history the next agent receives:
   *  - "full"       — every prior agent's turns, verbatim.
   *  - "summarized" — one folded summary of prior agents' transcripts via the
   *                   injected `summarize` hook; own history stays verbatim.
   *  - "none"       — nothing shared; the next agent sees only its own history.
   */
  readonly mode: CrossAgentContextMode;
  /** Injected summarizer (required when mode is "summarized"). */
  readonly summarize?: Summarizer;
  /** Token budget passed to the summarizer (defaults below). */
  readonly maxSummaryTokens?: number;
}

export interface SharedAgentTurns {
  readonly agentId: string;
  readonly turns: readonly ChatTurnMessage[];
}

/** The context an incoming agent receives from summarizeFor(). */
export interface CrossAgentSharedContext {
  readonly mode: CrossAgentContextMode;
  /** The target agent's own prior turns, verbatim (empty for a new agent). */
  readonly ownTurns: readonly ChatTurnMessage[];
  /** Other agents' turns, verbatim — populated only in "full" mode. */
  readonly sharedTurns: readonly SharedAgentTurns[];
  /** Folded summary of other agents' transcripts — only in "summarized" mode. */
  readonly summary?: string;
}

export interface CrossAgentSessionContext {
  /** Append a turn — to the named agent, or to the active agent when omitted. */
  append(agentIdOrMessage: string | ChatTurnMessage, message?: ChatTurnMessage): void;
  /** Switch the active agent; a new agent starts empty. No history is lost. */
  switchAgent(agentId: string): void;
  activeAgentId(): string;
  /** Agent ids in join order (first-seen first). */
  agents(): readonly string[];
  /** Immutable snapshot of one agent's turns. */
  turns(agentId: string): readonly ChatTurnMessage[];
  /** The shared context the named (next) agent receives, per policy. */
  summarizeFor(agentId: string): Promise<CrossAgentSharedContext>;
}

export interface CrossAgentSessionContextOptions {
  readonly policy: CrossAgentContextPolicy;
  /** The initially active agent (defaults to "default"). */
  readonly initialAgentId?: string;
}

const DEFAULT_MAX_SUMMARY_TOKENS = 512;

function cloneTurns(turns: readonly ChatTurnMessage[]): ChatTurnMessage[] {
  return turns.map((turn) => ({ role: turn.role, content: turn.content }));
}

export function createCrossAgentSessionContext(
  options: CrossAgentSessionContextOptions
): CrossAgentSessionContext {
  const { policy } = options;
  const histories = new Map<string, ChatTurnMessage[]>();
  let activeAgentId = options.initialAgentId ?? "default";
  histories.set(activeAgentId, []);

  const historyFor = (agentId: string): ChatTurnMessage[] => {
    let history = histories.get(agentId);
    if (!history) {
      history = [];
      histories.set(agentId, history);
    }
    return history;
  };

  /** Role-tagged, secret-scrubbed render of the other agents' transcripts. */
  const renderOthersBlock = (targetAgentId: string): string => {
    const lines: string[] = [];
    for (const [agentId, turns] of histories) {
      if (agentId === targetAgentId) {
        continue;
      }
      for (const turn of turns) {
        lines.push(`[${agentId}] ${turn.role}: ${turn.content}`);
      }
    }
    return scrubSecretValues(lines.join("\n"));
  };

  const otherAgentIds = (targetAgentId: string): string[] =>
    [...histories.keys()].filter((agentId) => agentId !== targetAgentId);

  return {
    append(agentIdOrMessage, message) {
      if (typeof agentIdOrMessage === "string") {
        if (!message) {
          throw new Error("append(agentId, message) requires a message.");
        }
        historyFor(agentIdOrMessage).push(message);
      } else {
        historyFor(activeAgentId).push(agentIdOrMessage);
      }
    },

    switchAgent(agentId) {
      historyFor(agentId); // create-on-switch, empty when new
      activeAgentId = agentId;
    },

    activeAgentId() {
      return activeAgentId;
    },

    agents() {
      return [...histories.keys()];
    },

    turns(agentId) {
      return cloneTurns(histories.get(agentId) ?? []);
    },

    async summarizeFor(agentId): Promise<CrossAgentSharedContext> {
      const ownTurns = cloneTurns(histories.get(agentId) ?? []);
      const others = otherAgentIds(agentId);

      if (policy.mode === "none" || others.length === 0) {
        const shared: CrossAgentSharedContext = { mode: policy.mode, ownTurns, sharedTurns: [] };
        return shared;
      }

      if (policy.mode === "full") {
        const shared: CrossAgentSharedContext = {
          mode: "full",
          ownTurns,
          sharedTurns: others.map((otherId) => ({
            agentId: otherId,
            turns: cloneTurns(histories.get(otherId) ?? [])
          }))
        };
        return shared;
      }

      // "summarized"
      if (!policy.summarize) {
        throw new Error(
          "CrossAgentContextPolicy mode 'summarized' requires an injected summarize hook."
        );
      }
      const summary = (
        await policy.summarize({
          transcriptBlock: renderOthersBlock(agentId),
          label: "history",
          maxTokens: policy.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS,
          customInstructions: `Summarize prior agents' turns as shared context for the next agent '${agentId}'.`
        })
      ).trim();
      const shared: CrossAgentSharedContext = {
        mode: "summarized",
        ownTurns,
        sharedTurns: [],
        ...(summary.length > 0 ? { summary } : {})
      };
      return shared;
    }
  };
}
