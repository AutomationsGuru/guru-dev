import {
  DEFAULT_OPERATOR_NOTIFY_CONFIG,
  OperatorNotifyChannelSchema,
  type OperatorNotifyChannel,
  type OperatorNotifyConfig,
  type OperatorNotifyConfigInput
} from "./operatorNotifyConfig.js";

export interface OperatorNotifyEvent {
  /** Short notification title (e.g. "Task complete"). */
  readonly title: string;
  /** Human-readable body. Secrets are scrubbed before any channel sees it. */
  readonly message: string;
  /** Optional structured context; values are also scrubbed. */
  readonly metadata?: Record<string, string | number | boolean | undefined> | undefined;
}

export interface ScrubbedOperatorNotifyEvent {
  readonly title: string;
  readonly message: string;
  readonly metadata?: Record<string, string | undefined> | undefined;
}

export interface OperatorNotifyDeps {
  /** Destination for the "log" channel. */
  readonly logSink?: (message: string) => void;
  /** Destination for the "bell" channel. */
  readonly bellSink?: () => void;
  /** Optional desktop notifier; receives a structurally scrubbed event. No network here. */
  readonly desktopNotifier?: (event: ScrubbedOperatorNotifyEvent) => void;
}

export interface OperatorNotifyResult {
  readonly notified: boolean;
  readonly channels: readonly OperatorNotifyChannel[];
}

const SECRET_KEY_PATTERN = /\b(api[_-]?key|apikey|token|secret|password|credential|auth|authorization|bearer|private[_-]?key|access[_-]?token|refresh[_-]?token)\b/i;

// Common secret value shapes: hex/base64 strings, JWT-ish tokens, provider prefixes.
const SECRET_VALUE_PATTERN = new RegExp(
  [
    "\\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|glpat|Bearer|Basic)[_\\-][A-Za-z0-9_\\-]+\\b",
    "\\b[a-f0-9]{32,}\\b",
    "\\b[A-Za-z0-9+/]{40,}={0,2}\\b",
    "\\beyJ[A-Za-z0-9_-]*\\.eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*\\b"
  ].join("|"),
  "gi"
);

/**
 * Redact secret-like content from a free-form string.
 * This is structural: any key that looks like a secret name, or any value that
 * looks like a token/hash, is replaced with [REDACTED].
 */
export function scrubSecrets(value: string): string {
  // First pass: redact key=value / key: value / "key": "value" style secrets.
  const keyRedacted = value.replace(
    new RegExp(`(${SECRET_KEY_PATTERN.source})\\s*[:=]\\s*["']?[^\\s"';,}\\]]+["']?`, "gi"),
    "$1: [REDACTED]"
  );

  // Second pass: redact standalone secret-looking values.
  return keyRedacted.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}

function scrubMetadata(
  metadata: OperatorNotifyEvent["metadata"]
): Record<string, string | undefined> | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      result[key] = undefined;
      continue;
    }
    // If the metadata KEY itself names a secret, redact the value structurally
    // regardless of its shape — a secret under a secret-named key is a secret.
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = scrubSecrets(String(value));
    }
  }
  return result;
}

export function scrubEvent(event: OperatorNotifyEvent): ScrubbedOperatorNotifyEvent {
  return {
    title: scrubSecrets(event.title),
    message: scrubSecrets(event.message),
    metadata: scrubMetadata(event.metadata)
  };
}

export function createOperatorNotifyConfig(input?: OperatorNotifyConfigInput): OperatorNotifyConfig {
  if (input === undefined) {
    return DEFAULT_OPERATOR_NOTIFY_CONFIG;
  }
  return OperatorNotifyConfigSchema.parse(input);
}

/**
 * Send an operator notification through the enabled channels.
 *
 * - If the config has `enabled: false`, this is a silent no-op.
 * - The event is structurally scrubbed before any channel payload is built.
 * - The "log" channel writes to `deps.logSink` (default `console.log`).
 * - The "bell" channel writes a terminal bell to `deps.bellSink` (default
 *   `process.stdout.write("\x07")`).
 * - The "desktop" channel calls `deps.desktopNotifier` if supplied; otherwise it
 *   is skipped without error. There is no built-in network phone-home.
 */
export function notifyOperator(
  config: OperatorNotifyConfig,
  event: OperatorNotifyEvent,
  deps: OperatorNotifyDeps = {}
): OperatorNotifyResult {
  if (!config.enabled) {
    return { notified: false, channels: [] };
  }

  const channels = config.channels.filter((channel) => OperatorNotifyChannelSchema.safeParse(channel).success);
  if (channels.length === 0) {
    return { notified: false, channels: [] };
  }

  const scrubbed = scrubEvent(event);

  for (const channel of channels) {
    switch (channel) {
      case "log": {
        const sink = deps.logSink ?? console.log;
        const payload = scrubbed.metadata
          ? `[notify] ${scrubbed.title}: ${scrubbed.message} ${JSON.stringify(scrubbed.metadata)}`
          : `[notify] ${scrubbed.title}: ${scrubbed.message}`;
        sink(payload);
        break;
      }
      case "bell": {
        const sink = deps.bellSink ?? (() => process.stdout.write("\x07"));
        sink();
        break;
      }
      case "desktop": {
        if (deps.desktopNotifier) {
          deps.desktopNotifier(scrubbed);
        }
        break;
      }
      default: {
        // Exhaustiveness: unreachable because of the channel filter.
        const _exhaustive: never = channel;
        throw new Error(`Unsupported notify channel: ${_exhaustive}`);
      }
    }
  }

  return { notified: true, channels };
}
