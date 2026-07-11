/**
 * Launch context (Natural-Language Suit Trigger wave, ADR
 * 2026-07-05-nl-suit-trigger, THERE v2 §17 scenario 14 — "sit down, type guru,
 * say what today is, and feel the suit come on"). Two pure helpers for the
 * sit-down moment: derive a suit topic from plain-prose work-declarations, and
 * format the actual calendar date so the model has it in context.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
] as const;

/**
 * A stable, unambiguous date line for the system prompt — the OPERATOR's local
 * calendar date. UTC was wrong here: an evening operator west of UTC (or a
 * morning operator east of it) got told the model a different day than the one
 * on their wall clock, so "today"/"yesterday" in prompts drifted by one day.
 */
export function formatTodayLine(now: Date): string {
  const weekday = WEEKDAYS[now.getDay()];
  const month = MONTHS[now.getMonth()];
  const pad = (value: number): string => String(value).padStart(2, "0");
  const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `Today is ${weekday}, ${now.getDate()} ${month} ${now.getFullYear()} (${iso}).`;
}

/**
 * Work-declaration patterns: "finances today", "let's do the ledger", "working on
 * the auth refactor". The capture group is the topic. Ordered most-specific first.
 */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  /^(?:let'?s|lets)\s+(?:do|work on|tackle|handle|start|build|dig into|sort out)\s+(.+)$/iu,
  /^(?:we(?:'re| are)|i(?:'m| am))\s+(?:doing|working on|focus(?:ing)? on|tackling|building|handling)\s+(.+)$/iu,
  /^(?:doing|working on|focus(?:ing)? on|time for|up next[:,]?\s*|first up[:,]?\s*)\s*(.+)$/iu,
  /^today(?:'?s focus)?[:,]\s*(.+)$/iu,
  /^(.+?)\s+today[.!]*$/iu
];

/** Words that make a "<x> today" match a comment, not a work declaration. */
const LEADING_FILLER = new Set(["it", "it's", "its", "that", "this", "there", "everything", "nothing", "is", "was", "here"]);

/**
 * Derive a suit topic from a plain-prose work declaration, or null when the text
 * isn't one. Conservative by design — it only fires on the naked opening turn, and
 * the result is announced + reversible (`/role off`), so the cost of a near-miss is
 * low; the cost of firing on ordinary chat would be high, hence the guards:
 * questions, commands, @-refs, and anything longer than a short declaration are out.
 */
export function detectSuitIntent(text: string): string | null {
  const trimmed = text.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("!") ||
    trimmed.endsWith("?")
  ) {
    return null;
  }
  // A "what are we doing today" declaration is short; long prose is a real prompt.
  if (trimmed.split(/\s+/u).length > 8) {
    return null;
  }
  for (const pattern of DECLARATION_PATTERNS) {
    const match = pattern.exec(trimmed);
    const captured = match?.[1]?.replace(/[.!,\s]+$/u, "").trim();
    const firstWord = captured?.split(/\s+/u)[0]?.toLowerCase();
    if (captured && captured.length >= 2 && captured.length <= 48 && firstWord && !LEADING_FILLER.has(firstWord)) {
      return captured;
    }
  }
  return null;
}
