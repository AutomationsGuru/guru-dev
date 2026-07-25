import { describe, expect, it } from "vitest";

import { scoreAgentReadiness } from '../../src/quality/agentReadinessScore.js';

describe("scoreAgentReadiness", () => {
  it("reports an empty project at level 0 with every remediation gap", () => {
    expect(
      scoreAgentReadiness({
        hasAgentsFile: false,
        hasCiConfig: false,
        hasSandboxFriendlyScripts: false,
        hasTestScript: false
      })
    ).toEqual({
      level: 0,
      gaps: ["test-script", "agents-file", "ci-config", "sandbox-friendly-scripts"]
    });
  });

  it("reports a project with every signal at level 4 without gaps", () => {
    expect(
      scoreAgentReadiness({
        hasAgentsFile: true,
        hasCiConfig: true,
        hasSandboxFriendlyScripts: true,
        hasTestScript: true
      })
    ).toEqual({ level: 4, gaps: [] });
  });

  it("lists only missing signals in a stable remediation order", () => {
    expect(
      scoreAgentReadiness({
        hasAgentsFile: true,
        hasCiConfig: false,
        hasSandboxFriendlyScripts: false,
        hasTestScript: true
      })
    ).toEqual({ level: 2, gaps: ["ci-config", "sandbox-friendly-scripts"] });
  });

  it("rejects incomplete signal packets", () => {
    expect(() => scoreAgentReadiness({ hasTestScript: true } as never)).toThrow();
  });
});
