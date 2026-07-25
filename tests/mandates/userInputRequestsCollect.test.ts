import { describe, expect, it } from "vitest";

import {
  collect,
  type UserInputRequest
} from '../../src/mandates/userInputRequestsCollect.js';
import type { ChatTurnMessage } from '../../src/model/directChat.js';

/** Helper: build a ChatTurnMessage with defaults. */
function msg(
  role: ChatTurnMessage["role"],
  content: string
): ChatTurnMessage {
  return { role, content };
}

describe("userInputRequestsCollect.collect — extract pending approval requests from messages", () => {
  it("returns an empty list when there are no messages", () => {
    expect(collect([])).toEqual([]);
  });

  it("returns an empty list when no messages contain approval requests", () => {
    const messages: ChatTurnMessage[] = [
      msg("system", "You are an agent."),
      msg("user", "Do something."),
      msg("assistant", "I did the thing."),
      msg("assistant", "Here is the result.")
    ];
    expect(collect(messages)).toEqual([]);
  });

  it("returns an empty list when only user/system messages contain approval keywords", () => {
    const messages: ChatTurnMessage[] = [
      msg("system", "Handle (requires approval) carefully."),
      msg("user", "I need (requires approval) for this.")
    ];
    expect(collect(messages)).toEqual([]);
  });

  it("finds a structured [APPROVAL_REQUEST] marker in an assistant message", () => {
    const messages: ChatTurnMessage[] = [
      msg("user", "Delete the old backups."),
      msg(
        "assistant",
        "I'll need approval for that.\n" +
          "[APPROVAL_REQUEST] toolId=bash reason=rm -rf is destructive hardEdge=true"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual<UserInputRequest>({
      messageIndex: 2,
      toolId: "bash",
      reason: "rm -rf is destructive",
      hardEdge: true
    });
  });

  it("finds a structured marker with hardEdge=false", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "[APPROVAL_REQUEST] toolId=write reason=create new file hardEdge=false"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.hardEdge).toBe(false);
  });

  it("finds a structured marker without an explicit hardEdge flag", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "[APPROVAL_REQUEST] toolId=web_fetch reason=fetch external docs"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      messageIndex: 1,
      toolId: "web_fetch",
      hardEdge: false
    });
  });

  it("finds multiple structured markers across multiple assistant messages", () => {
    const messages: ChatTurnMessage[] = [
      msg("system", "Agent starting."),
      msg(
        "assistant",
        "I need to run: [APPROVAL_REQUEST] toolId=bash reason=rm -rf tmp hardEdge=true"
      ),
      msg("user", "ok"),
      msg(
        "assistant",
        "Also this: [APPROVAL_REQUEST] toolId=write reason=update config hardEdge=false"
      ),
      msg(
        "assistant",
        "And: [APPROVAL_REQUEST] toolId=web_fetch reason=check docs"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(3);
    expect(result[0]?.messageIndex).toBe(2);  // first assistant msg
    expect(result[0]?.toolId).toBe("bash");
    expect(result[0]?.hardEdge).toBe(true);
    expect(result[1]?.messageIndex).toBe(4);  // second assistant msg
    expect(result[1]?.toolId).toBe("write");
    expect(result[1]?.hardEdge).toBe(false);
    expect(result[2]?.messageIndex).toBe(5);  // third assistant msg
    expect(result[2]?.toolId).toBe("web_fetch");
    expect(result[2]?.hardEdge).toBe(false);
  });

  it("finds approval requests via keyword fallback: (requires approval)", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "This operation requires approval. (requires approval) (hard edge: destructive)"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe("approval required");
    expect(result[0]?.hardEdge).toBe(true);
  });

  it("keyword fallback without (hard edge) sets hardEdge=false", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "Please confirm: write to config. (requires approval)"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.hardEdge).toBe(false);
  });

  it("keyword fallback infers toolId from toolId= marker in the message", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "Failed: no mandate covers write+exec. (requires approval) toolId=bash"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.toolId).toBe("bash");
  });

  it("keyword fallback infers toolId from toolId: marker in the message", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "Need approval. (requires approval) toolId: write"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.toolId).toBe("write");
  });

  it("keyword fallback infers toolId from known tool names in text", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "I need to run a bash command with rm -rf. (requires approval)"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.toolId).toBe("bash");
  });

  it("keyword fallback with no identifiable toolId defaults to 'unknown'", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "Something needs your approval. (requires approval)"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.toolId).toBe("unknown");
    expect(result[0]?.reason).toBe("approval required");
  });

  it("structured marker takes priority over keyword fallback in the same message", () => {
    const messages: ChatTurnMessage[] = [
      msg(
        "assistant",
        "[APPROVAL_REQUEST] toolId=bash reason=destructive op hardEdge=true\n" +
          "Also (requires approval) for something else."
      )
    ];

    const result = collect(messages);
    // Structured marker matched first; the keyword fallback for the same message
    // is skipped via `continue`.
    expect(result).toHaveLength(1);
    expect(result[0]?.toolId).toBe("bash");
  });

  it("messageIndex is 1-based for human readability", () => {
    const messages: ChatTurnMessage[] = [
      msg("system", "You are helpful."),
      msg("user", "hi"),
      msg("assistant", "Hello!"),
      msg("user", "do it"),
      msg(
        "assistant",
        "[APPROVAL_REQUEST] toolId=edit reason=change file"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.messageIndex).toBe(5);
  });

  it("ACCEPTANCE: mixed structured + keyword fallback across multiple messages", () => {
    const messages: ChatTurnMessage[] = [
      msg("system", "Agent."),
      msg(
        "assistant",
        "[APPROVAL_REQUEST] toolId=bash reason=rm -rf /tmp old hardEdge=true"
      ),
      msg("user", "ok"),
      msg(
        "assistant",
        "Done. Now I need to write a file. (requires approval)"
      ),
      msg(
        "assistant",
        "[APPROVAL_REQUEST] toolId=web_fetch reason=fetch URL hardEdge=false"
      )
    ];

    const result = collect(messages);
    expect(result).toHaveLength(3);

    // First: structured marker with hardEdge
    expect(result[0]).toMatchObject({
      messageIndex: 2,
      toolId: "bash",
      hardEdge: true
    });

    // Second: keyword fallback (infers toolId from "write" in text)
    expect(result[1]).toMatchObject({
      messageIndex: 4,
      hardEdge: false
    });

    // Third: structured marker
    expect(result[2]).toMatchObject({
      messageIndex: 5,
      toolId: "web_fetch",
      hardEdge: false
    });
  });
});