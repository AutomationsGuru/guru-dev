export type InferHarnessInput = {
  providerId: string;
  modelId: string;
  baseUrl?: string;
  /** Explicit profile id from config/flag. Non-empty always wins. */
  explicit?: string | null;
};

export type HarnessProfileId =
  | "native"
  | "minimal"
  | "claude-shaped"
  | "kimi-shaped"
  | "qwen-shaped"
  | string;

type FamilyRule = {
  readonly profileId: string;
  readonly tokens: readonly string[];
};

/** Family rules: first match wins. Match case-insensitively against provider then model tokens. */
const FAMILY_RULES: readonly FamilyRule[] = [
  { profileId: "claude-shaped", tokens: ["anthropic", "claude"] },
  { profileId: "kimi-shaped", tokens: ["moonshot", "kimi"] },
  { profileId: "qwen-shaped", tokens: ["qwen"] }
] as const;

const TOKEN_SPLIT = /[/:\-_.]+/u;

function normalizeTokens(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesFamily(haystack: readonly string[], tokens: readonly string[]): boolean {
  return tokens.some((token) => haystack.includes(token) || haystack.some((part) => part.includes(token)));
}

/**
 * Infer a harness profile id for the session.
 * Pure, table-driven, no I/O.
 */
export function inferHarness(input: InferHarnessInput): string {
  const explicit = input.explicit?.trim();
  if (explicit) {
    return explicit;
  }

  const providerTokens = normalizeTokens(input.providerId);
  const modelTokens = normalizeTokens(input.modelId);

  for (const rule of FAMILY_RULES) {
    if (matchesFamily(providerTokens, rule.tokens) || matchesFamily(modelTokens, rule.tokens)) {
      return rule.profileId;
    }
  }

  return "native";
}
