import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Zod schema for a single Planner Sign-off Token.
 */
export const PlannerSignoffTokenSchema = z
  .object({
    tokenId: z.string().trim().min(1),
    sectionId: z.string().trim().min(1),
    status: z.enum(["issued", "verified", "consumed"]),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    consumedAt: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export type PlannerSignoffToken = z.infer<typeof PlannerSignoffTokenSchema>;

/**
 * Zod schema for the sign-off token manager state.
 */
export const PlannerSignoffTokenStateSchema = z
  .object({
    tokens: z.record(z.string(), PlannerSignoffTokenSchema),
    approvedSections: z.record(z.string(), z.string().datetime())
  })
  .strict();

export type PlannerSignoffTokenState = z.infer<typeof PlannerSignoffTokenStateSchema>;

/**
 * Creates a fresh, empty state for tracking planner sign-off tokens.
 */
export function createInitialState(): PlannerSignoffTokenState {
  return {
    tokens: {},
    approvedSections: {}
  };
}

export interface IssueTokenOptions {
  readonly ttlMs?: number;
  readonly expiresAt?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Issues a new sign-off token for a specific design section.
 *
 * @param state - The current token state.
 * @param sectionId - The design section ID being approved.
 * @param options - Optional TTL, explicit expiration, and metadata.
 * @returns The issued token and the new token state.
 */
export function issueToken(
  state: PlannerSignoffTokenState,
  sectionId: string,
  options: IssueTokenOptions = {}
): { readonly token: PlannerSignoffToken; readonly nextState: PlannerSignoffTokenState } {
  const trimmedSectionId = sectionId.trim();
  if (!trimmedSectionId) {
    throw new Error("Section ID cannot be empty.");
  }

  const tokenId = randomUUID();
  const now = new Date();

  let expiresAtStr: string | undefined;
  if (options.expiresAt) {
    const parsed = Date.parse(options.expiresAt);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid expiresAt timestamp: ${options.expiresAt}`);
    }
    expiresAtStr = new Date(parsed).toISOString();
  } else if (options.ttlMs !== undefined) {
    if (options.ttlMs <= 0) {
      throw new Error("TTL must be a positive number.");
    }
    expiresAtStr = new Date(now.getTime() + options.ttlMs).toISOString();
  }

  const token: PlannerSignoffToken = {
    tokenId,
    sectionId: trimmedSectionId,
    status: "issued",
    issuedAt: now.toISOString(),
    ...(expiresAtStr ? { expiresAt: expiresAtStr } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {})
  };

  // Internal sanity check via Zod schema
  PlannerSignoffTokenSchema.parse(token);

  const nextState: PlannerSignoffTokenState = {
    ...state,
    tokens: {
      ...state.tokens,
      [tokenId]: token
    }
  };

  return { token, nextState };
}

/**
 * Verifies that a sign-off token is valid, matches the section, and has not expired.
 * Sets the token status to "verified" in the returned state.
 *
 * @param state - The current token state.
 * @param tokenId - The unique ID of the token to verify.
 * @param sectionId - Optional design section ID to verify against.
 * @returns The verified token and the updated token state.
 */
export function verifyToken(
  state: PlannerSignoffTokenState,
  tokenId: string,
  sectionId?: string
): { readonly token: PlannerSignoffToken; readonly nextState: PlannerSignoffTokenState } {
  const token = state.tokens[tokenId];
  if (!token) {
    throw new Error(`Token with ID "${tokenId}" was not found.`);
  }

  if (sectionId !== undefined) {
    const trimmedSectionId = sectionId.trim();
    if (token.sectionId !== trimmedSectionId) {
      throw new Error(
        `Token "${tokenId}" is issued for section "${token.sectionId}", but expected section "${trimmedSectionId}".`
      );
    }
  }

  if (token.status === "consumed") {
    throw new Error(`Token "${tokenId}" has already been consumed.`);
  }

  if (token.expiresAt) {
    const expiresAtMs = Date.parse(token.expiresAt);
    if (Date.now() > expiresAtMs) {
      throw new Error(`Token "${tokenId}" has expired.`);
    }
  }

  const updatedToken: PlannerSignoffToken = {
    ...token,
    status: "verified"
  };

  const nextState: PlannerSignoffTokenState = {
    ...state,
    tokens: {
      ...state.tokens,
      [tokenId]: updatedToken
    }
  };

  return { token: updatedToken, nextState };
}

/**
 * Verifies and consumes a sign-off token, marking the corresponding section as approved.
 *
 * @param state - The current token state.
 * @param tokenId - The unique ID of the token to consume.
 * @param sectionId - Optional design section ID to verify against.
 * @returns The consumed token and the updated token state.
 */
export function consumeToken(
  state: PlannerSignoffTokenState,
  tokenId: string,
  sectionId?: string
): { readonly token: PlannerSignoffToken; readonly nextState: PlannerSignoffTokenState } {
  const { token, nextState: verifiedState } = verifyToken(state, tokenId, sectionId);

  const now = new Date();
  const consumedToken: PlannerSignoffToken = {
    ...token,
    status: "consumed",
    consumedAt: now.toISOString()
  };

  const nextState: PlannerSignoffTokenState = {
    ...verifiedState,
    tokens: {
      ...verifiedState.tokens,
      [tokenId]: consumedToken
    },
    approvedSections: {
      ...verifiedState.approvedSections,
      [consumedToken.sectionId]: now.toISOString()
    }
  };

  return { token: consumedToken, nextState };
}

/**
 * Checks whether a design section has been signed off/approved.
 *
 * @param state - The current token state.
 * @param sectionId - The design section ID to check.
 */
export function isSectionApproved(state: PlannerSignoffTokenState, sectionId: string): boolean {
  const trimmed = sectionId.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed in state.approvedSections;
}

/**
 * Checks whether we can transition to a next section based on the approval of a current section.
 *
 * @param state - The current token state.
 * @param nextSectionId - The target section to proceed to.
 * @param currentSectionId - The previous/current section ID that must be approved.
 */
export function canProceedToSection(
  state: PlannerSignoffTokenState,
  nextSectionId: string,
  currentSectionId?: string
): boolean {
  const trimmedNext = nextSectionId.trim();
  if (!trimmedNext) {
    throw new Error("Next Section ID cannot be empty.");
  }

  if (currentSectionId === undefined) {
    return true;
  }

  const trimmedCurrent = currentSectionId.trim();
  if (!trimmedCurrent) {
    throw new Error("Current Section ID cannot be empty if provided.");
  }

  return isSectionApproved(state, trimmedCurrent);
}

/**
 * Validates sequential design transitions, throwing an error if the previous section is not approved.
 *
 * @param state - The current token state.
 * @param nextSectionId - The target section to proceed to.
 * @param currentSectionId - The previous/current section ID that must be approved.
 */
export function validateTransition(
  state: PlannerSignoffTokenState,
  nextSectionId: string,
  currentSectionId?: string
): void {
  const trimmedNext = nextSectionId.trim();
  if (!trimmedNext) {
    throw new Error("Next Section ID cannot be empty.");
  }

  if (currentSectionId !== undefined) {
    const trimmedCurrent = currentSectionId.trim();
    if (!trimmedCurrent) {
      throw new Error("Current Section ID cannot be empty if provided.");
    }

    if (!isSectionApproved(state, trimmedCurrent)) {
      throw new Error(
        `Cannot transition to section "${trimmedNext}": previous section "${trimmedCurrent}" has not been approved.`
      );
    }
  }
}

/**
 * Object-oriented state manager wrapper for managing sign-off tokens and section approvals.
 */
export class PlannerSignoffTokenManager {
  private state: PlannerSignoffTokenState;

  constructor(initialState?: PlannerSignoffTokenState) {
    if (initialState) {
      this.state = PlannerSignoffTokenStateSchema.parse(initialState);
    } else {
      this.state = createInitialState();
    }
  }

  /**
   * Retrieves a parsed clone of the current state.
   */
  public getState(): PlannerSignoffTokenState {
    return PlannerSignoffTokenStateSchema.parse(this.state);
  }

  /**
   * Issues a new token for a design section.
   */
  public issueToken(
    sectionId: string,
    options?: IssueTokenOptions
  ): PlannerSignoffToken {
    const { token, nextState } = issueToken(this.state, sectionId, options);
    this.state = nextState;
    return token;
  }

  /**
   * Verifies a token's validity for a design section.
   */
  public verifyToken(tokenId: string, sectionId?: string): PlannerSignoffToken {
    const { token, nextState } = verifyToken(this.state, tokenId, sectionId);
    this.state = nextState;
    return token;
  }

  /**
   * Consumes a token and signs off on the design section.
   */
  public consumeToken(tokenId: string, sectionId?: string): PlannerSignoffToken {
    const { token, nextState } = consumeToken(this.state, tokenId, sectionId);
    this.state = nextState;
    return token;
  }

  /**
   * Returns whether a section is approved.
   */
  public isSectionApproved(sectionId: string): boolean {
    return isSectionApproved(this.state, sectionId);
  }

  /**
   * Returns whether we can proceed to a next section.
   */
  public canProceedToSection(nextSectionId: string, currentSectionId?: string): boolean {
    return canProceedToSection(this.state, nextSectionId, currentSectionId);
  }

  /**
   * Throws an error if we cannot transition to the next section.
   */
  public validateTransition(nextSectionId: string, currentSectionId?: string): void {
    validateTransition(this.state, nextSectionId, currentSectionId);
  }
}
