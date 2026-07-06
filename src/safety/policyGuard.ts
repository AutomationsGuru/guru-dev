import { isAbsolute, relative, resolve } from "node:path";

export interface SensitiveMatch {
  readonly name: string;
  readonly kind: string;
}

interface SensitivePattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

export interface ToolPolicy {
  readonly repoRoot: string;
  readonly riskyPathPatterns: readonly string[];
  readonly secretAllowList: readonly string[];
  readonly allowRiskyPaths: boolean;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly blockers: readonly string[];
}

export function isRiskyPath(candidatePath: string, riskyPathPatterns: readonly string[]): boolean {
  const normalized = resolve(candidatePath).toLowerCase().replace(/\\/gu, "/");
  const segments = normalized.split("/").filter(Boolean);

  return riskyPathPatterns.some((pattern) => {
    const normalizedPattern = pattern.toLowerCase().replace(/\\/gu, "/");
    const patternSegments = normalizedPattern.split("/").filter(Boolean);

    if (patternSegments.length === 0) {
      return false;
    }

    if (patternSegments.length === 1) {
      const patternSegment = patternSegments[0];
      if (!patternSegment) {
        return false;
      }

      return segments.some((segment) => segment === patternSegment || segment.startsWith(`${patternSegment}.`));
    }

    return normalized.includes(patternSegments.join("/"));
  });
}

export function detectPotentialSecrets(
  inputs: Array<{ readonly name: string; readonly value?: string }>,
  allowList: readonly string[] = []
): readonly SensitiveMatch[] {
  const secretPatterns: readonly SensitivePattern[] = [
    { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
    {
      kind: "secret-assignment",
      pattern: /\b(?:api[_-]?key|secret|password|access[_-]?token|oauth[_-]?token|pat|credential|private[_-]?key)\s*[:=]\s*[^\s]{8,}/i
    },
    { kind: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
    { kind: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
    { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
    { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_\-]{20,}\b/ },
    { kind: "slack-token", pattern: /\bxox[aboprs]-[0-9A-Za-z-]{20,}\b/ },
    { kind: "stripe-secret-key", pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
    { kind: "vercel-token", pattern: /\bvercel_[0-9A-Za-z]{20,}\b/i },
    { kind: "neon-token", pattern: /\bnapi_[0-9A-Za-z]{20,}\b/i },
    { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
  ];

  const matches: SensitiveMatch[] = [];
  for (const input of inputs) {
    const value = input.value;
    if (!value) {
      continue;
    }

    // Allow-list exact match prevents known-good values from triggering without treating regexes as trusted code.
    if (allowList.includes(value)) {
      continue;
    }

    const matchedPattern = secretPatterns.find((secretPattern) => secretPattern.pattern.test(value));
    if (matchedPattern) {
      matches.push({ name: input.name, kind: matchedPattern.kind });
    }
  }

  return matches;
}

export function guardWritePath(targetPath: string, policy: ToolPolicy): PolicyDecision {
  const blockers: string[] = [];
  const repoRoot = resolve(policy.repoRoot);
  const resolvedTarget = resolve(repoRoot, targetPath);
  const relativeTarget = relative(repoRoot, resolvedTarget);

  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    blockers.push("Target path escapes the repository root (path redacted).");
  }

  if (!policy.allowRiskyPaths && isRiskyPath(resolvedTarget, policy.riskyPathPatterns)) {
    blockers.push("Target path is blocked by risky-path policy (path redacted).");
  }

  return { allowed: blockers.length === 0, blockers };
}

export function guardContent(namedValues: Array<{ readonly name: string; readonly value?: string }>, policy: ToolPolicy): PolicyDecision {
  const detections = detectPotentialSecrets(namedValues, policy.secretAllowList);
  const blockers = detections.map((detection) => `Potential secret or sensitive value detected in ${detection.name} (${detection.kind}; value redacted)`);

  return { allowed: blockers.length === 0, blockers };
}
