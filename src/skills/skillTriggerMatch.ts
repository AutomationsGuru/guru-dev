import type { SkillManifest } from "./schemas.js";
import {
  parseSkillTriggers,
  type SkillTrigger,
  type SkillTriggerContext
} from "./skillTriggers.js";

/**
 * Match skills whose triggers are satisfied by the current context.
 *
 * Rules (in order):
 * 1. No triggers → always-eligible (legacy always-on skill).
 * 2. Any single trigger match makes the skill eligible (OR semantics).
 * 3. A trigger type only fires when its corresponding context field is present;
 *    a pathGlob with no `currentPath` in context simply doesn't match (doesn't
 *    count as a false positive — the user isn't working on any file yet).
 *
 * Returns the filtered array of eligible manifests in their original order.
 */
export function matchSkillTriggers(
  skills: readonly SkillManifest[],
  context: SkillTriggerContext
): SkillManifest[] {
  return skills.filter((skill) => {
    const triggers = parseSkillTriggers(skill.metadata as Record<string, unknown>);
    if (triggers.length === 0) {
      return true; // always-eligible legacy skill
    }
    return triggers.some((trigger) => triggerMatchesContext(trigger, context));
  });
}

function triggerMatchesContext(trigger: SkillTrigger, context: SkillTriggerContext): boolean {
  switch (trigger.type) {
    case "pathGlob":
      return matchPathGlob(trigger.glob, context.currentPath);
    case "keyword":
      return matchKeyword(trigger.keyword, context.message);
    case "command":
      return matchCommand(trigger.command, context.command);
  }
}

// ── Path glob matching ──────────────────────────────────────────────

/**
 * Lightweight glob matching — supports `*` (single-segment wildcard) and
 * `**` (any-depth globstar).  No external dependency.
 */
function matchPathGlob(glob: string, path: string | undefined): boolean {
  if (!path) {
    return false;
  }

  const normalizedPath = path.replace(/\\/g, "/");

  // Double-star (**): match zero-or-more directory segments.
  if (glob.includes("**")) {
    const regex = globToRegex(glob);
    return regex.test(normalizedPath);
  }

  // Single-star only: faster segment-by-segment match.
  return matchStarGlob(glob, normalizedPath);
}

function globToRegex(glob: string): RegExp {
  let pattern = "";
  let i = 0;

  while (i < glob.length) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      // ** matches zero or more path segments
      // Consume any trailing slash after ** (e.g. "**/" → "**/" both handled)
      if (glob[i + 2] === "/") {
        i += 3;
        pattern += "(?:.+/)?";
      } else {
        i += 2;
        pattern += ".*";
      }
    } else if (glob[i] === "*") {
      // * matches within a single segment (no slashes)
      i += 1;
      pattern += "[^/]*";
    } else {
      // Escape regex special characters
      const ch = glob[i++]!;
      if (".+^${}()|[]\\".includes(ch)) {
        pattern += "\\" + ch;
      } else {
        pattern += ch;
      }
    }
  }

  return new RegExp("^" + pattern + "$");
}

function matchStarGlob(pattern: string, path: string): boolean {
  const segments = pattern.split("/");
  const pathSegments = path.split("/");

  if (segments.length !== pathSegments.length) {
    // Star-only glob requires same segment count
    if (!pattern.includes("*")) {
      return false;
    }
    // Re-check: even with *, different segment counts can't match
    // unless we have ** (which we already handled above)
    return false;
  }

  for (let i = 0; i < segments.length; i++) {
    if (!matchStarSegment(segments[i]!, pathSegments[i]!)) {
      return false;
    }
  }

  return true;
}

function matchStarSegment(patternSegment: string, pathSegment: string): boolean {
  if (patternSegment === "*") {
    return true;
  }

  if (!patternSegment.includes("*")) {
    return patternSegment === pathSegment;
  }

  // Segment with embedded *: "foo*.ts", "*.test.ts", etc.
  const regex = new RegExp(
    "^" +
      patternSegment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*") +
      "$"
  );
  return regex.test(pathSegment);
}

// ── Keyword matching ─────────────────────────────────────────────────

function matchKeyword(keyword: string, message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return message.toLowerCase().includes(keyword.toLowerCase());
}

// ── Command matching ─────────────────────────────────────────────────

function matchCommand(command: string, contextCommand: string | undefined): boolean {
  if (!contextCommand) {
    return false;
  }
  return contextCommand.trim().toLowerCase() === command.trim().toLowerCase();
}
