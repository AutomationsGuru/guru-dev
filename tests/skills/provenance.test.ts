import {
  gateSkillInstall,
  gateSkillInstalls,
  sourceMatchesAllow,
  type SkillInstallCandidate
} from "../../src/skills/provenance.js";

function candidate(overrides: Partial<SkillInstallCandidate> = {}): SkillInstallCandidate {
  return {
    skillId: "demo-skill",
    origin: "third-party",
    sourceId: "github:acme/demo-skill",
    body: "# Demo\n\nA harmless skill body.\n",
    ...overrides
  };
}

describe("sourceMatchesAllow", () => {
  it("matches an exact source id", () => {
    expect(sourceMatchesAllow("github:acme/demo", "github:acme/demo")).toBe(true);
    expect(sourceMatchesAllow("github:acme/other", "github:acme/demo")).toBe(false);
  });

  it("matches a trailing-* prefix glob", () => {
    expect(sourceMatchesAllow("github:acme/demo", "github:acme/*")).toBe(true);
    expect(sourceMatchesAllow("github:evil/demo", "github:acme/*")).toBe(false);
  });
});

describe("gateSkillInstall — first-party", () => {
  it.each(["home", "project", "bundled"] as const)("admits a %s skill without an allow entry", (origin) => {
    const decision = gateSkillInstall(candidate({ origin, sourceId: undefined }));

    expect(decision.admit).toBe(true);
    expect(decision.reason).toBe("first-party");
    expect(decision.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("gateSkillInstall — third-party requires explicit allow", () => {
  it("REFUSES a blind third-party install with no allow entry", () => {
    const decision = gateSkillInstall(candidate());

    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe("unallowed-third-party");
    expect(decision.summary).toContain("no operator allow entry");
  });

  it("REFUSES a third-party install with no sourceId", () => {
    const decision = gateSkillInstall(candidate({ sourceId: undefined }));

    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe("unallowed-third-party");
  });

  it("admits a third-party install when an exact allow entry matches", () => {
    const decision = gateSkillInstall(candidate(), [
      { sourcePattern: "github:acme/demo-skill", reason: "vetted by Matthew" }
    ]);

    expect(decision.admit).toBe(true);
    expect(decision.reason).toBe("allowed-third-party");
    expect(decision.summary).toContain("vetted by Matthew");
  });

  it("admits a third-party install under a glob allow entry", () => {
    const decision = gateSkillInstall(candidate(), [
      { sourcePattern: "github:acme/*", reason: "acme org vetted" }
    ]);

    expect(decision.admit).toBe(true);
  });

  it("REFUSES when the allow entry covers a different source", () => {
    const decision = gateSkillInstall(candidate({ sourceId: "github:evil/skill" }), [
      { sourcePattern: "github:acme/*", reason: "acme org vetted" }
    ]);

    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe("unallowed-third-party");
  });
});

describe("gateSkillInstall — secret scan is a hard limit for every origin", () => {
  it("REFUSES a first-party skill whose body contains a private key", () => {
    const decision = gateSkillInstall(
      candidate({ origin: "home", sourceId: undefined, body: "# X\n-----BEGIN PRIVATE KEY-----\nabc\n" })
    );

    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe("secret-detected");
    expect(decision.secretKinds).toContain("private-key");
  });

  it("REFUSES even an ALLOWED third-party skill carrying a token", () => {
    const decision = gateSkillInstall(
      candidate({ body: "# X\napi_key: abcdef1234567890secret\n" }),
      [{ sourcePattern: "github:acme/*", reason: "vetted" }]
    );

    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe("secret-detected");
    // Presence-over-value: the summary must never echo the secret.
    expect(decision.summary).not.toContain("abcdef1234567890secret");
  });
});

describe("gateSkillInstalls", () => {
  it("partitions admitted from refused", () => {
    const { admitted, refused } = gateSkillInstalls(
      [
        candidate({ skillId: "ok", origin: "home", sourceId: undefined }),
        candidate({ skillId: "blind" })
      ],
      []
    );

    expect(admitted.map((entry) => entry.candidate.skillId)).toEqual(["ok"]);
    expect(refused.map((entry) => entry.candidate.skillId)).toEqual(["blind"]);
  });
});
