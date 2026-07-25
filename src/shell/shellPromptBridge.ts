/**
 * Shell prompt bridge (IDEA-F112-SHELL-BRIDGE-01, R-FC-SHELL).
 *
 * A small dispatch API that accepts a shell-line payload — agent id plus a
 * prompt, or the `:suggest` meta-command — and routes it toward an existing
 * Guru session (headless or TUI) without requiring a full interactive TUI
 * takeover. The bridge is shell-agnostic: it consumes the already-captured
 * line, so any shell integration (ZSH `:` prefix mode, bash bindings, …) can
 * drive it.
 *
 * Boundary: this module parses and shapes intents into structured actions.
 * It never executes shell commands itself (see shellSuggestBuffer.ts — the
 * suggest path is a pure string transform), and it never owns a session; the
 * actual session work is delegated to the injected `onPrompt` callback, which
 * the session layer wires to its backend.
 */

import { suggestToBuffer } from "./shellSuggestBuffer.js";

/** Error thrown for every malformed or unroutable shell line. */
export class ShellPromptBridgeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ShellPromptBridgeError";
  }
}

/** Meta-commands recognized in first position after the `:` prefix. */
const META_COMMANDS = new Set(["suggest"]);

/** Parsed intent produced from a raw shell line. */
export type ShellIntent =
  | {
      readonly kind: "prompt";
      readonly agent: string;
      readonly prompt: string;
    }
  | {
      readonly kind: "suggest";
      readonly agent: string;
      readonly prompt: string;
    };

/** Structured action handed to the session layer after dispatch. */
export type ShellAction =
  | {
      readonly kind: "prompt";
      readonly agent: string;
      readonly prompt: string;
    }
  | {
      readonly kind: "suggest";
      readonly agent: string;
      readonly prompt: string;
      /** Command string staged for the operator's buffer; never executed here. */
      readonly command: string;
    };

/** Callback the session layer provides to receive parsed prompt intents. */
export type ShellPromptCallback = (
  intent: Extract<ShellIntent, { kind: "prompt" }>
) => void | Promise<void>;

export interface ShellPromptBridgeOptions {
  readonly onPrompt?: ShellPromptCallback;
}

export interface ShellPromptBridge {
  /** Parse `line` and return the structured action for the session layer. */
  readonly dispatch: (line: string) => Promise<ShellAction>;
}

/**
 * Parse a raw shell line into a dispatch intent.
 *
 * Grammar (after trimming and collapsing whitespace):
 *   `:<agent> [prompt …]`          → prompt intent
 *   `:suggest <agent> [prompt …]`  → suggest intent
 *
 * Throws {@link ShellPromptBridgeError} for a missing `:` prefix, a missing
 * agent id, an unknown meta-command in first position, or a malformed token.
 */
export function parseLine(line: string): ShellIntent {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new ShellPromptBridgeError("shell prompt bridge: empty line");
  }
  if (!normalized.startsWith(":")) {
    throw new ShellPromptBridgeError(
      `shell prompt bridge: line must start with ':' — got ${JSON.stringify(normalized.slice(0, 32))}`
    );
  }

  const body = normalized.slice(1).trim();
  if (!body) {
    throw new ShellPromptBridgeError("shell prompt bridge: missing agent id after ':'");
  }

  const firstSpace = body.indexOf(" ");
  const head = firstSpace === -1 ? body : body.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();

  if (!/^[a-z][a-z0-9-]*$/i.test(head)) {
    throw new ShellPromptBridgeError(
      `shell prompt bridge: unknown meta-command or malformed agent token ${JSON.stringify(head)}`
    );
  }

  if (META_COMMANDS.has(head.toLowerCase())) {
    if (!rest) {
      throw new ShellPromptBridgeError(`shell prompt bridge: ':${head}' requires an agent id`);
    }
    const agentEnd = rest.indexOf(" ");
    const agent = agentEnd === -1 ? rest : rest.slice(0, agentEnd);
    const prompt = agentEnd === -1 ? "" : rest.slice(agentEnd + 1).trim();
    return { kind: "suggest", agent, prompt };
  }

  return { kind: "prompt", agent: head, prompt: rest };
}

/**
 * Create a shell prompt bridge. `onPrompt` is the session-layer stub that
 * receives parsed prompt intents; suggest intents are answered locally via
 * {@link suggestToBuffer} and never reach the callback.
 */
export function createShellPromptBridge(options: ShellPromptBridgeOptions = {}): ShellPromptBridge {
  return {
    async dispatch(line: string): Promise<ShellAction> {
      const intent = parseLine(line);
      if (intent.kind === "suggest") {
        return {
          kind: "suggest",
          agent: intent.agent,
          prompt: intent.prompt,
          command: suggestToBuffer(intent.prompt ? `${intent.agent} ${intent.prompt}` : intent.agent)
        };
      }
      await options.onPrompt?.(intent);
      return { kind: "prompt", agent: intent.agent, prompt: intent.prompt };
    }
  };
}
