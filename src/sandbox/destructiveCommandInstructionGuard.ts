/**
 * Destructive command instruction guard (IDEA-F265-DESTRUCT-GUARD-01).
 *
 * Classifies shell commands for destructive patterns so the instruction-guard
 * layer can force `always_require` on dangerous commands and deny them outright
 * under `never_require` — even when the operator has lowered tool friction.
 *
 * Composes: F109 blocklist · hard limits (§3.1 no destruction without preservation).
 *
 * MAF-convergent: the MAF per-tool `approval_mode` (always_require / never_require)
 * is adapted here as a command-level classifier rather than a tool-level blanket —
 * destructive commands force the highest friction regardless of the tool's mode.
 */

/**
 * Result of classifying a shell command for destructive intent.
 * Callers use this to gate execution:
 * - `destructive → true` forces `always_require` on the owning tool call.
 * - Under `never_require`, a destructive command is DENIED outright.
 */
export interface CommandClassification {
  /** The command is destructive — must always prompt and is never auto-approved. */
  readonly destructive: boolean;
  /** Human-readable explanation for logging / operator display. */
  readonly reason: string;
  /** Which destructive patterns matched (empty when non-destructive). */
  readonly matchedPatterns: readonly string[];
}

/** Non-rm destructive shell forms (aligned with mandate evaluate.ts DESTRUCTIVE_PATTERNS). */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  // Force-push: --force (not the safer --force-with-lease).
  /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i,
  // Force-push short form: `git push -f` / `git push origin main -f`.
  /\bgit\s+push\b(?:\s+\S+)*?\s+-f(?:\s|$)/i,
  // Hard reset.
  /\bgit\s+reset\s+--hard\b/i,
  // Force-clean.
  /\bgit\s+clean\s+-[a-z]*f/i,
  // Disk formatter / raw dd write.
  /\b(mkfs|dd\s+if=)/i,
  // System halt / restart.
  /\bshutdown\b|\breboot\b/i,
  // Fork bomb — no word boundary (colon is not a word char).
  /:\(\)\s*\{/i,
];

const PATTERN_LABELS: Readonly<Record<number, string>> = {
  0: "git push --force",
  1: "git push -f",
  2: "git reset --hard",
  3: "git clean -f",
  4: "mkfs | dd write",
  5: "shutdown | reboot",
  6: "fork bomb",
};

/**
 * True when a shell command is a recursive+force `rm` in any common flag shape:
 * `rm -rf`, `rm -fr`, `rm -r -f`, `rm -f -r`, `rm --recursive --force`.
 * Recursive alone (`rm -r`) is NOT destructive-class (no force).
 */
export function isDestructiveRm(command: string): boolean {
  if (!/\brm\b/i.test(command)) {
    return false;
  }
  // Scan tokens after the first `rm` until a non-flag path argument.
  const tokens = command.split(/\s+/u).filter((t) => t.length > 0);
  const rmAt = tokens.findIndex((t) => t.toLowerCase() === "rm");
  if (rmAt < 0) {
    return false;
  }
  let recursive = false;
  let force = false;
  for (let i = rmAt + 1; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "--") {
      break;
    }
    if (token.startsWith("--")) {
      const long = token.toLowerCase();
      if (long === "--recursive" || long === "--dir" || long === "--directory") {
        recursive = true;
      } else if (long === "--force") {
        force = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      // Short cluster: -rf / -fr / -R / -f / -rF etc.
      const letters = token.slice(1);
      if (/[rR]/u.test(letters)) {
        recursive = true;
      }
      if (/[fF]/u.test(letters)) {
        force = true;
      }
      continue;
    }
    // First non-flag token is the path/target — stop scanning flags.
    break;
  }
  return recursive && force;
}

/**
 * Windows / PowerShell recursive-delete shapes that escalate like `rm -rf`.
 *
 * Covered:
 * - `del /s /q …`, `del /f /s /q …`
 * - `rmdir /s /q …`, `rd /s /q …`
 * - `Remove-Item -Recurse -Force …` (and `-r` / `-fo` short forms)
 * - `ri -r -fo …` (Remove-Item alias)
 */
export function isDestructiveWindowsDelete(command: string): boolean {
  // cmd.exe: del/erase with /S (recurse) — quiet or not, the tree is wiped.
  if (/\b(?:del|erase)\b/i.test(command) && /\/s\b/i.test(command)) {
    return true;
  }
  // cmd.exe: rmdir/rd with /S.
  if (/\b(?:rmdir|rd)\b/i.test(command) && /\/s\b/i.test(command)) {
    return true;
  }
  // PowerShell Remove-Item / ri: recurse + force in any flag shape.
  if (/\b(?:remove-item|ri)\b/i.test(command)) {
    const recurse = /(?:-recurse\b|-r\b)/i.test(command);
    const force = /(?:-force\b|-fo\b)/i.test(command);
    if (recurse && force) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies a shell command string for destructive intent.
 *
 * Returns a structured classification that instruction guards use to enforce
 * the §3.1 hard limit (no destruction without preservation):
 *
 * - `destructive: true` → the command MUST prompt even in YOLO; `never_require`
 *   is overridden to `always_require` or the call is denied outright.
 * - `destructive: false` → the command is safe to run under the tool's
 *   configured approval mode.
 *
 * This is a command-level check, not a tool-level one — a `bash` tool may be
 * set to `never_require`, but destructive commands within it still escalate.
 */
export function classify(command: string): CommandClassification {
  const patterns: string[] = [];

  // rm -rf / rm --recursive --force
  if (isDestructiveRm(command)) {
    patterns.push("rm -rf (recursive force remove)");
  }

  // Windows recursive force delete
  if (isDestructiveWindowsDelete(command)) {
    patterns.push("windows recursive force delete (del /s, rmdir /s, Remove-Item -Recurse -Force)");
  }

  // Fixed destructive patterns (git force-push, mkfs, shutdown, etc.)
  for (let i = 0; i < DESTRUCTIVE_PATTERNS.length; i += 1) {
    if (DESTRUCTIVE_PATTERNS[i]!.test(command)) {
      patterns.push(PATTERN_LABELS[i] ?? `destructive pattern #${i}`);
    }
  }

  if (patterns.length > 0) {
    return {
      destructive: true,
      reason: `destructive command detected: ${patterns.join("; ")}`,
      matchedPatterns: patterns,
    };
  }

  return {
    destructive: false,
    reason: "no destructive patterns matched",
    matchedPatterns: [],
  };
}
