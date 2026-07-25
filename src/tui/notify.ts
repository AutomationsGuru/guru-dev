/**
 * Unfocused (out-of-band) operator notify (IDEA-E5, R-CR-NOTIFY).
 *
 * Best-effort desktop/terminal notification via the OSC-9 escape sequence
 * (iTerm2, kitty, WezTerm, Windows Terminal, and most modern terminals show a
 * desktop toast; terminals that do not implement OSC-9 silently ignore it).
 *
 * DESIGN RULE — degrade silently: notification is a nicety, never a hard
 * dependency. Any unsupported environment, closed stream, or write failure
 * returns `{ delivered: false, reason }` instead of throwing. The TUI must
 * never crash because a toast could not be shown.
 *
 * SECURITY: title/body are truncated at the first control character before
 * being embedded in an escape sequence — a model- or transcript-derived
 * string can never inject its own OSC/CSI sequence through this surface.
 */

export interface NotifyMessage {
  readonly title: string;
  readonly body: string;
}

export interface NotifyResult {
  readonly delivered: boolean;
  /** Present when delivered=false — why the notification was skipped. */
  readonly reason?: string;
}

export interface NotifyStream {
  write(chunk: string): boolean;
}

export interface NotifierOptions {
  readonly stream: NotifyStream;
  /** Whether the stream is an interactive terminal. */
  readonly isTty: boolean;
  /** TERM_PROGRAM value, when known. */
  readonly termProgram?: string | undefined;
  /** Environment snapshot for capability detection (never read for secrets). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface Notifier {
  notify(message: NotifyMessage): NotifyResult;
}

const ESC = "\x1b";
const ST = "\x1b\\";

/** Max code points kept from title / body — a toast is a glance, not a document. */
const MAX_TITLE = 120;
const MAX_BODY = 400;

/** First control character ends the text: no injected OSC/CSI/BEL/NL can pass. */
function sanitize(text: string, max: number): string {
  const controlIndex = text.search(/[\x00-\x1f\x7f]/u);
  const clean = controlIndex === -1 ? text : text.slice(0, controlIndex);
  return [...clean].slice(0, max).join("");
}

/** Render the OSC-9 sequence for a message (pure — testable without a terminal). */
export function renderOscNotification(message: NotifyMessage): string {
  const title = sanitize(message.title, MAX_TITLE);
  const body = sanitize(message.body, MAX_BODY);
  return `${ESC}]9;${title}: ${body}${ST}`;
}

/**
 * Terminals verified to render OSC-9 as a desktop toast. Everything else is
 * treated as unsupported (we degrade rather than spray escape bytes at a
 * terminal that would print them literally).
 */
const KNOWN_OSC9_TERM_PROGRAMS = new Set(["iTerm.app", "WezTerm", "kitty", "vscode", "Apple_Terminal"]);

function isSupported(options: NotifierOptions): boolean {
  if (options.termProgram && KNOWN_OSC9_TERM_PROGRAMS.has(options.termProgram)) {
    return true;
  }
  const term = options.env?.["TERM"] ?? "";
  if (/kitty|wezterm|alacritty|foot/i.test(term)) {
    return true;
  }
  // Windows Terminal sets WT_SESSION; it supports OSC-9 toasts since 1.12.
  if (options.env?.["WT_SESSION"]) {
    return true;
  }
  return false;
}

/**
 * Create a best-effort notifier bound to a stream. The returned notifier never
 * throws: unsupported terminal, non-TTY, or a failed write all resolve to
 * `{ delivered: false }` with a reason.
 */
export function createNotifier(options: NotifierOptions): Notifier {
  return {
    notify(message: NotifyMessage): NotifyResult {
      if (!options.isTty) {
        return { delivered: false, reason: "stream is not a TTY" };
      }
      if (!isSupported(options)) {
        return { delivered: false, reason: "terminal does not advertise OSC-9 support" };
      }
      try {
        options.stream.write(renderOscNotification(message));
        return { delivered: true };
      } catch {
        return { delivered: false, reason: "stream write failed" };
      }
    }
  };
}
