import {
  PlannerSignoffTokenSchema,
  PlannerSignoffTokenStateSchema,
  createInitialState,
  issueToken,
  verifyToken,
  consumeToken,
  isSectionApproved,
  canProceedToSection,
  validateTransition,
  PlannerSignoffTokenManager
} from '../../src/planner/plannerChunkSignoffToken.js';

describe("createInitialState", () => {
  it("should return a clean, empty initial state", () => {
    const state = createInitialState();
    expect(state).toEqual({
      tokens: {},
      approvedSections: {}
    });

    // Verify it complies with the schema
    const parsed = PlannerSignoffTokenStateSchema.parse(state);
    expect(parsed).toEqual(state);
  });
});

describe("PlannerSignoffTokenSchema", () => {
  it("should validate a complete and valid token structure", () => {
    const validToken = {
      tokenId: "test-uuid-1",
      sectionId: "section-1",
      status: "issued",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      metadata: { key: "value", num: 123 }
    };

    const parsed = PlannerSignoffTokenSchema.parse(validToken);
    expect(parsed).toEqual(validToken);
  });

  it("should reject invalid status or formatting", () => {
    // Missing tokenId
    expect(
      PlannerSignoffTokenSchema.safeParse({
        sectionId: "section-1",
        status: "issued",
        issuedAt: new Date().toISOString()
      }).success
    ).toBe(false);

    // Invalid status
    expect(
      PlannerSignoffTokenSchema.safeParse({
        tokenId: "id",
        sectionId: "section-1",
        status: "invalid-status",
        issuedAt: new Date().toISOString()
      }).success
    ).toBe(false);

    // Empty trimmed sectionId or tokenId
    expect(
      PlannerSignoffTokenSchema.safeParse({
        tokenId: "  ",
        sectionId: "section-1",
        status: "issued",
        issuedAt: new Date().toISOString()
      }).success
    ).toBe(false);

    // Invalid timestamp format
    expect(
      PlannerSignoffTokenSchema.safeParse({
        tokenId: "id",
        sectionId: "section-1",
        status: "issued",
        issuedAt: "not-a-datetime"
      }).success
    ).toBe(false);
  });
});

describe("issueToken", () => {
  it("should issue a token with default options", () => {
    const state = createInitialState();
    const { token, nextState } = issueToken(state, "section-1");

    expect(token.tokenId).toBeDefined();
    expect(token.sectionId).toBe("section-1");
    expect(token.status).toBe("issued");
    expect(token.issuedAt).toBeDefined();
    expect(token.expiresAt).toBeUndefined();
    expect(token.consumedAt).toBeUndefined();
    expect(token.metadata).toBeUndefined();

    expect(nextState.tokens[token.tokenId]).toEqual(token);
  });

  it("should handle custom expiresAt and metadata", () => {
    const state = createInitialState();
    const expiresAt = new Date(Date.now() + 5000).toISOString();
    const metadata = { version: "v1", count: 42 };

    const { token, nextState } = issueToken(state, "  section-1  ", {
      expiresAt,
      metadata
    });

    expect(token.sectionId).toBe("section-1"); // trimmed
    expect(token.expiresAt).toBe(expiresAt);
    expect(token.metadata).toEqual(metadata);
    expect(nextState.tokens[token.tokenId]).toEqual(token);
  });

  it("should support TTL in milliseconds", () => {
    const baseTime = new Date("2026-07-20T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      const state = createInitialState();
      const ttlMs = 10000; // 10 seconds
      const { token } = issueToken(state, "section-1", { ttlMs });

      const expectedExpiresAt = new Date(baseTime.getTime() + ttlMs).toISOString();
      expect(token.expiresAt).toBe(expectedExpiresAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should throw on invalid arguments", () => {
    const state = createInitialState();

    // Empty section ID
    expect(() => issueToken(state, "")).toThrow("Section ID cannot be empty.");
    expect(() => issueToken(state, "   ")).toThrow("Section ID cannot be empty.");

    // Invalid expiresAt format
    expect(() =>
      issueToken(state, "section-1", { expiresAt: "invalid-date" })
    ).toThrow("Invalid expiresAt timestamp: invalid-date");

    // Non-positive TTL
    expect(() => issueToken(state, "section-1", { ttlMs: 0 })).toThrow(
      "TTL must be a positive number."
    );
    expect(() => issueToken(state, "section-1", { ttlMs: -100 })).toThrow(
      "TTL must be a positive number."
    );
  });
});

describe("verifyToken", () => {
  it("should verify and transition status of an issued token", () => {
    const state = createInitialState();
    const { token: issuedToken, nextState: stateWithToken } = issueToken(state, "section-1");

    const { token: verifiedToken, nextState: finalState } = verifyToken(
      stateWithToken,
      issuedToken.tokenId
    );

    expect(verifiedToken.tokenId).toBe(issuedToken.tokenId);
    expect(verifiedToken.status).toBe("verified");
    expect(finalState.tokens[issuedToken.tokenId]?.status).toBe("verified");
  });

  it("should optionally check for section matching", () => {
    const state = createInitialState();
    const { token, nextState } = issueToken(state, "section-1");

    // Correct section
    const { token: verified } = verifyToken(nextState, token.tokenId, "section-1");
    expect(verified.sectionId).toBe("section-1");

    // Correct section with trimming
    const { token: verifiedTrimmed } = verifyToken(nextState, token.tokenId, "  section-1  ");
    expect(verifiedTrimmed.sectionId).toBe("section-1");

    // Mismatched section should throw
    expect(() => verifyToken(nextState, token.tokenId, "section-2")).toThrow(
      `Token "${token.tokenId}" is issued for section "section-1", but expected section "section-2".`
    );
  });

  it("should throw if token is not found", () => {
    const state = createInitialState();
    expect(() => verifyToken(state, "non-existent-id")).toThrow(
      'Token with ID "non-existent-id" was not found.'
    );
  });

  it("should throw if token is already consumed", () => {
    const state = createInitialState();
    const { token, nextState } = issueToken(state, "section-1");
    const { nextState: stateConsumed } = consumeToken(nextState, token.tokenId);

    expect(() => verifyToken(stateConsumed, token.tokenId)).toThrow(
      `Token "${token.tokenId}" has already been consumed.`
    );
  });

  it("should throw if token has expired", () => {
    const baseTime = new Date("2026-07-20T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      const state = createInitialState();
      const { token, nextState } = issueToken(state, "section-1", { ttlMs: 5000 });

      // Move system clock past expiration (e.g., 6 seconds)
      vi.setSystemTime(new Date(baseTime.getTime() + 6000));

      expect(() => verifyToken(nextState, token.tokenId)).toThrow(
        `Token "${token.tokenId}" has expired.`
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("consumeToken", () => {
  it("should verify, consume, and signoff a design section", () => {
    const baseTime = new Date("2026-07-20T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      const state = createInitialState();
      const { token, nextState: stateWithToken } = issueToken(state, "section-1");

      const { token: consumedToken, nextState: stateConsumed } = consumeToken(
        stateWithToken,
        token.tokenId
      );

      expect(consumedToken.status).toBe("consumed");
      expect(consumedToken.consumedAt).toBe(baseTime.toISOString());

      // Check section approval
      expect(stateConsumed.approvedSections["section-1"]).toBe(baseTime.toISOString());
      expect(isSectionApproved(stateConsumed, "section-1")).toBe(true);
      expect(isSectionApproved(stateConsumed, "section-2")).toBe(false);
      expect(isSectionApproved(stateConsumed, "   ")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should enforce double-consumption protection", () => {
    const state = createInitialState();
    const { token, nextState } = issueToken(state, "section-1");
    const { nextState: stateConsumed } = consumeToken(nextState, token.tokenId);

    expect(() => consumeToken(stateConsumed, token.tokenId)).toThrow(
      `Token "${token.tokenId}" has already been consumed.`
    );
  });
});

describe("transitions and approvals", () => {
  it("should validate proceeds and transitions correctly", () => {
    const state1 = createInitialState();

    // No current section required to proceed to section-1
    expect(canProceedToSection(state1, "section-1")).toBe(true);
    expect(() => validateTransition(state1, "section-1")).not.toThrow();

    // Cannot proceed to section-2 because section-1 is not approved yet
    expect(canProceedToSection(state1, "section-2", "section-1")).toBe(false);
    expect(() => validateTransition(state1, "section-2", "section-1")).toThrow(
      'Cannot transition to section "section-2": previous section "section-1" has not been approved.'
    );

    // Let's issue and consume token for section-1
    const { token, nextState: stateWithToken } = issueToken(state1, "section-1");
    const { nextState: stateApproved } = consumeToken(stateWithToken, token.tokenId);

    // Now we can proceed to section-2
    expect(canProceedToSection(stateApproved, "section-2", "section-1")).toBe(true);
    expect(() => validateTransition(stateApproved, "section-2", "section-1")).not.toThrow();
  });

  it("should throw on invalid transition section IDs", () => {
    const state = createInitialState();

    expect(() => canProceedToSection(state, "")).toThrow("Next Section ID cannot be empty.");
    expect(() => canProceedToSection(state, "section-1", "")).toThrow(
      "Current Section ID cannot be empty if provided."
    );

    expect(() => validateTransition(state, "")).toThrow("Next Section ID cannot be empty.");
    expect(() => validateTransition(state, "section-1", "  ")).toThrow(
      "Current Section ID cannot be empty if provided."
    );
  });
});

describe("PlannerSignoffTokenManager", () => {
  it("should initialize with empty state if none provided", () => {
    const manager = new PlannerSignoffTokenManager();
    expect(manager.getState()).toEqual(createInitialState());
  });

  it("should initialize with custom initial state if valid", () => {
    const customState = {
      tokens: {
        "test-token": {
          tokenId: "test-token",
          sectionId: "section-1",
          status: "issued" as const,
          issuedAt: new Date().toISOString()
        }
      },
      approvedSections: {
        "section-prev": new Date().toISOString()
      }
    };

    const manager = new PlannerSignoffTokenManager(customState);
    expect(manager.getState()).toEqual(customState);
  });

  it("should throw if custom initial state is invalid", () => {
    const invalidState = {
      tokens: {
        "test-token": {
          tokenId: "test-token",
          sectionId: "section-1",
          status: "not-a-valid-status", // Invalid status enum
          issuedAt: new Date().toISOString()
        }
      },
      approvedSections: {}
    };

    expect(() => new PlannerSignoffTokenManager(invalidState as any)).toThrow();
  });

  it("should wrap token operations and mutate state", () => {
    const manager = new PlannerSignoffTokenManager();

    // 1. Issue
    const token = manager.issueToken("section-A", { metadata: { foo: "bar" } });
    expect(token.status).toBe("issued");
    expect(token.sectionId).toBe("section-A");
    expect(manager.isSectionApproved("section-A")).toBe(false);

    // 2. Verify
    const verified = manager.verifyToken(token.tokenId, "section-A");
    expect(verified.status).toBe("verified");

    // 3. Consume
    const consumed = manager.consumeToken(token.tokenId, "section-A");
    expect(consumed.status).toBe("consumed");
    expect(manager.isSectionApproved("section-A")).toBe(true);

    // 4. Transitions
    expect(manager.canProceedToSection("section-B", "section-A")).toBe(true);
    expect(manager.canProceedToSection("section-B", "section-C")).toBe(false);

    expect(() => manager.validateTransition("section-B", "section-A")).not.toThrow();
    expect(() => manager.validateTransition("section-B", "section-C")).toThrow(
      'Cannot transition to section "section-B": previous section "section-C" has not been approved.'
    );
  });
});
