import {
  composeDogfoodOrchestrators,
  createBeeperDogfoodOrchestrator,
  createCodePasteAndGoDogfoodOrchestrator,
  createCyberChefDogfoodOrchestrator,
  createDefaultDogfoodOrchestrators,
  createSentryDogfoodOrchestrator
} from "../../src/dogfood/orchestrators.js";

describe("dogfood orchestrators", () => {
  it("should compose candidates from multiple orchestrators", () => {
    const candidates = composeDogfoodOrchestrators([createSentryDogfoodOrchestrator(), createCyberChefDogfoodOrchestrator()]);

    expect(candidates.map((candidate) => candidate.label)).toEqual(["sentry-workflow", "cyberchef-tier2"]);
    expect(candidates.map((candidate) => candidate.orchestratorId)).toEqual(["sentry", "cyberchef"]);
  });

  it("should include Beeper, CyberChef, code-paste-and-go, and Sentry orchestrators in the default roster", () => {
    const orchestratorIds = createDefaultDogfoodOrchestrators().map((orchestrator) => orchestrator.id);

    expect(orchestratorIds).toEqual(expect.arrayContaining(["beeper", "cyberchef", "code-paste-and-go", "sentry"]));
  });

  it("should keep remote tier-2 targets explicit", () => {
    const candidates = composeDogfoodOrchestrators([createBeeperDogfoodOrchestrator(), createCyberChefDogfoodOrchestrator()]);
    const remoteLabels = candidates.filter((candidate) => candidate.remoteUrl).map((candidate) => candidate.label);

    expect(remoteLabels).toEqual(["beeper-imessage-tier2", "cyberchef-tier2"]);
  });

  it("should provide a local code-paste-and-go representative target", () => {
    const candidates = createCodePasteAndGoDogfoodOrchestrator().getCandidates();

    expect(candidates).toEqual([
      {
        label: "code-paste-and-go-representative",
        orchestratorId: "code-paste-and-go",
        tier: "tier-2",
        relativePath: ".powertoys",
        signal: "paste"
      }
    ]);
  });
});
