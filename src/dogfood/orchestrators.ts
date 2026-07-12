export type DogfoodTier = "core" | "tier-2";

export interface DogfoodRepoCandidate {
  readonly label: string;
  readonly orchestratorId: string;
  readonly tier: DogfoodTier;
  readonly signal: string;
  readonly relativePath?: string;
  readonly remoteUrl?: string;
  readonly remoteRef?: string;
}

export interface DogfoodOrchestrator {
  readonly id: string;
  readonly description: string;
  getCandidates(): readonly DogfoodRepoCandidate[];
}

export function composeDogfoodOrchestrators(orchestrators: readonly DogfoodOrchestrator[]): readonly DogfoodRepoCandidate[] {
  // Per-orchestrator resilience (review 2026-07-08): the old flatMap let one
  // failing orchestrator's getCandidates() throw and abort the ENTIRE portfolio
  // composition — no candidates, no summary, leaked temp clones. Skip a failing
  // orchestrator (warn) so the rest of the portfolio still runs.
  const candidates: DogfoodRepoCandidate[] = [];
  for (const orchestrator of orchestrators) {
    try {
      candidates.push(...orchestrator.getCandidates());
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[dogfood] orchestrator '${orchestrator.id}' failed to enumerate candidates and was skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return candidates;
}

export function createCoreDogfoodOrchestrator(): DogfoodOrchestrator {
  return {
    id: "core-portfolio",
    description: "Local baseline harness and adjacent operating repos.",
    getCandidates: () => [
      { label: "guruharness-baseline", orchestratorId: "core-portfolio", tier: "core", relativePath: ".guruharness", signal: "harness" },
      { label: "skills-workflow", orchestratorId: "core-portfolio", tier: "core", relativePath: ".agents/skills", signal: "skills" },
      { label: "review-gate-config", orchestratorId: "core-portfolio", tier: "core", relativePath: ".agents/knowledge-base", signal: "reviewGate" }
    ]
  };
}

export function createSentryDogfoodOrchestrator(): DogfoodOrchestrator {
  return {
    id: "sentry",
    description: "Sentry-adjacent workflow coverage through a local integration repo.",
    getCandidates: () => [{ label: "sentry-workflow", orchestratorId: "sentry", tier: "core", relativePath: ".camofox", signal: "sentry" }]
  };
}

export function createBeeperDogfoodOrchestrator(): DogfoodOrchestrator {
  return {
    id: "beeper",
    description: "Beeper-adjacent local coverage plus opt-in public Beeper source coverage.",
    getCandidates: () => [
      { label: "beeper-adjacent-workflow", orchestratorId: "beeper", tier: "core", relativePath: ".cursor", signal: "beeper" },
      {
        label: "beeper-imessage-tier2",
        orchestratorId: "beeper",
        tier: "tier-2",
        remoteUrl: "https://github.com/beeper/imessage.git",
        remoteRef: "main",
        signal: "beeper"
      }
    ]
  };
}

export function createCyberChefDogfoodOrchestrator(): DogfoodOrchestrator {
  return {
    id: "cyberchef",
    description: "Opt-in public CyberChef source coverage through a temporary shallow checkout.",
    getCandidates: () => [
      {
        label: "cyberchef-tier2",
        orchestratorId: "cyberchef",
        tier: "tier-2",
        remoteUrl: "https://github.com/gchq/CyberChef.git",
        remoteRef: "master",
        signal: "cyberchef"
      }
    ]
  };
}

export function createCodePasteAndGoDogfoodOrchestrator(): DogfoodOrchestrator {
  return {
    id: "code-paste-and-go",
    description: "Representative local paste/code workflow coverage when a matching repo is present.",
    getCandidates: () => [
      {
        label: "code-paste-and-go-representative",
        orchestratorId: "code-paste-and-go",
        tier: "tier-2",
        relativePath: ".powertoys",
        signal: "paste"
      }
    ]
  };
}

export function createDefaultDogfoodOrchestrators(): readonly DogfoodOrchestrator[] {
  return [
    createCoreDogfoodOrchestrator(),
    createSentryDogfoodOrchestrator(),
    createBeeperDogfoodOrchestrator(),
    createCyberChefDogfoodOrchestrator(),
    createCodePasteAndGoDogfoodOrchestrator()
  ];
}
