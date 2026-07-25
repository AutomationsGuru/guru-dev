/**
 * Router classifier slot — F315.
 *
 * A pluggable classifier (rules or model) behind one interface.
 * The default classifier is a heuristic that scores agents by keyword
 * overlap with their name + description. Classifiers can be swapped at
 * runtime through the slot registry.
 */

// ── Core types ──────────────────────────────────────────────────

/** An agent registered for classification routing. */
export interface AgentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Input to a classifier: what the user said and which agents are available. */
export interface ClassifyInput {
  /** The user's turn text. */
  readonly turn: string;
  /** Available agents with name + description for routing features. */
  readonly agents: readonly AgentDescriptor[];
  /** Recent conversation history lines (oldest first, optional). */
  readonly history?: readonly string[];
}

/** A single classification decision. */
export interface ClassifyResult {
  /** The id of the selected agent. */
  readonly selectedAgentId: string;
  /** Human-readable reason for the selection. */
  readonly reason: string;
  /** Confidence in [0.0, 1.0]. 0 = random/fallback, 1 = certain. */
  readonly confidence: number;
}

// ── Classifier function type ────────────────────────────────────

/** A classifier function: takes input and produces a selection. */
export type ClassifierFn = (input: ClassifyInput) => ClassifyResult;

// ── Slot registry ───────────────────────────────────────────────

export interface RouterClassifierSlot {
  /** Classify the input using the currently active classifier. */
  readonly classify: (input: ClassifyInput) => ClassifyResult;

  /** Register a named classifier, making it available for activation. */
  readonly register: (name: string, classifier: ClassifierFn) => void;

  /** Activate a previously registered classifier by name. Throws if unknown. */
  readonly activate: (name: string) => void;

  /** List all registered classifier names. */
  readonly list: () => readonly string[];

  /** Return the name of the currently active classifier. */
  readonly active: () => string;
}

// ── Default heuristic classifier ────────────────────────────────

const DEFAULT_AGENT_ID = "default";

/** Remove punctuation and collapse whitespace before tokenising. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 0);
}

/** Score one agent against a set of turn tokens. */
function scoreAgent(
  agent: AgentDescriptor,
  turnTokens: Set<string>
): { score: number; matched: string[] } {
  const fieldTokens = tokenize(`${agent.name} ${agent.description}`);
  const matched: string[] = [];
  let score = 0;

  for (const token of fieldTokens) {
    if (turnTokens.has(token) && !matched.includes(token)) {
      matched.push(token);
      // Longer tokens are more specific — weight them higher.
      score += token.length;
    }
  }

  return { score, matched };
}

const MIN_CONFIDENCE = 0.05;

/**
 * Heuristic classifier: scores each agent by keyword overlap between
 * the user turn and the agent's name + description. Falls back to the
 * first agent (or "default") when no keyword matches.
 */
export function createHeuristicClassifier(): ClassifierFn {
  return (input: ClassifyInput): ClassifyResult => {
    const turnTokens = new Set(tokenize(input.turn));

    if (input.agents.length === 0) {
      return {
        selectedAgentId: DEFAULT_AGENT_ID,
        reason: "No agents registered — falling back to default.",
        confidence: 1.0
      };
    }

    let bestAgent = input.agents[0]!;
    let bestScore = -1;
    let bestMatched: string[] = [];

    for (const agent of input.agents) {
      const { score, matched } = scoreAgent(agent, turnTokens);
      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
        bestMatched = matched;
      }
    }

    if (bestScore <= 0) {
      return {
        selectedAgentId: bestAgent.id,
        reason: `No keywords matched any agent description — fell back to "${bestAgent.name}" (${bestAgent.id}).`,
        confidence: MIN_CONFIDENCE
      };
    }

    const confidence = Math.min(
      1.0,
      Math.max(MIN_CONFIDENCE + 0.05, bestScore / (bestScore + turnTokens.size))
    );

    return {
      selectedAgentId: bestAgent.id,
      reason: `Matched keywords [${bestMatched.join(", ")}] in agent "${bestAgent.name}" (${bestAgent.id}).`,
      confidence: Math.round(confidence * 100) / 100
    };
  };
}

// ── Slot factory ────────────────────────────────────────────────

const DEFAULT_CLASSIFIER_NAME = "heuristic";

/**
 * Create a router classifier slot. Comes pre-registered with a
 * heuristic (rules-based) classifier as the default active classifier.
 */
export function createRouterClassifierSlot(): RouterClassifierSlot {
  const classifiers = new Map<string, ClassifierFn>();
  let activeName = DEFAULT_CLASSIFIER_NAME;

  classifiers.set(activeName, createHeuristicClassifier());

  const slot: RouterClassifierSlot = {
    classify(input) {
      const fn = classifiers.get(activeName);
      if (!fn) {
        throw new Error(`Active classifier "${activeName}" is not registered.`);
      }
      return fn(input);
    },

    register(name, classifier) {
      if (classifiers.has(name)) {
        throw new Error(`Classifier "${name}" is already registered.`);
      }
      classifiers.set(name, classifier);
    },

    activate(name) {
      if (!classifiers.has(name)) {
        throw new Error(`Classifier "${name}" is not registered.`);
      }
      activeName = name;
    },

    list() {
      return [...classifiers.keys()].sort();
    },

    active() {
      return activeName;
    }
  };

  return slot;
}
