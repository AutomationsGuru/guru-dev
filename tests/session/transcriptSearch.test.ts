import { describe, expect, it } from "vitest";

import type { ChatTurnMessage } from '../../src/model/directChat.js';
import {
  indexMessages,
  search,
  type TranscriptIndex,
} from '../../src/session/transcriptSearch.js';

function msg(role: ChatTurnMessage["role"], content: string): ChatTurnMessage {
  return { role, content };
}

describe("transcriptSearch", () => {
  describe("indexMessages + search", () => {
    it("returns hits whose content contains the keyword", () => {
      const messages: ChatTurnMessage[] = [
        msg("user", "How do I configure the router?"),
        msg("assistant", "The router lives in src/router."),
        msg("user", "Thanks, that is clear."),
      ];
      const index = indexMessages(messages);

      const hits = search(index, "router");
      expect(hits).toHaveLength(2);
      expect(hits[0]!.message.role).toBe("user");
      expect(hits[0]!.message.content).toContain("configure the router");
      expect(hits[1]!.message.role).toBe("assistant");
    });

    it("matches case-insensitively and ignores punctuation/word boundaries", () => {
      const messages: ChatTurnMessage[] = [
        msg("assistant", "Compaction reclaims context space."),
      ];
      const index = indexMessages(messages);

      const hits = search(index, "COMPACTION");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.message.content).toContain("Compaction");
    });

    it("matches all keywords when the query has multiple terms (AND semantics)", () => {
      const messages: ChatTurnMessage[] = [
        msg("user", "retry the failed request"),
        msg("assistant", "the retry budget is exhausted"),
        msg("user", "retry policy is fine"),
      ];
      const index = indexMessages(messages);

      const hits = search(index, "retry budget");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.message.role).toBe("assistant");
    });

    it("returns an empty array when no message matches", () => {
      const messages: ChatTurnMessage[] = [msg("user", "hello world")];
      const index = indexMessages(messages);

      expect(search(index, "missing")).toEqual([]);
    });

    it("returns an empty array for a blank query and never throws", () => {
      const messages: ChatTurnMessage[] = [msg("user", "hello world")];
      const index = indexMessages(messages);

      expect(search(index, "")).toEqual([]);
      expect(search(index, "   ")).toEqual([]);
    });

    it("does not duplicate a hit when the keyword appears twice in one message", () => {
      const messages: ChatTurnMessage[] = [
        msg("user", "deploy deploy"), // keyword appears twice in one message
        msg("assistant", "deploy again"),
      ];
      const index = indexMessages(messages);

      const hits = search(index, "deploy");
      expect(hits).toHaveLength(2);
      expect(hits.map((h) => h.message.role)).toEqual(["user", "assistant"]);
    });
  });

  describe("secret redaction", () => {
    it("redacts token-shaped secrets from returned hit content (never exposes the value)", () => {
      const apiKey = "sk-ant-1234567890abcdefXYZ";
      const messages: ChatTurnMessage[] = [
        msg("user", `here is my key: ${apiKey}`),
        msg("assistant", "no secret here"),
      ];
      const index = indexMessages(messages);

      const hits = search(index, "key");
      expect(hits).toHaveLength(1);
      const content = hits[0]!.message.content;
      expect(content).not.toContain(apiKey);
      expect(content).toContain("[redacted");
    });

    it("redacts secret-word assignments (password=...) while keeping the key visible", () => {
      const messages: ChatTurnMessage[] = [
        msg("user", "set DB_PASSWORD=s3cr3t-value-tail in env"),
      ];
      const index = indexMessages(messages);

      const hits = search(index, "password");
      expect(hits).toHaveLength(1);
      const content = hits[0]!.message.content;
      expect(content).not.toContain("s3cr3t-value-tail");
      expect(content).toContain("DB_PASSWORD");
      expect(content).toContain("[redacted");
    });

    it("hits expose only redacted content in every field, with no value leak", () => {
      const bearer = "Bearer ya29.abCdEfGhIjKlMnOpQrStUv";
      const messages: ChatTurnMessage[] = [
        msg("assistant", `auth header was ${bearer}`),
      ];
      const index = indexMessages(messages);

      const hits = search(index, "auth");
      expect(hits).toHaveLength(1);
      const serialized = JSON.stringify(hits[0]);
      expect(serialized).not.toContain("ya29.abCdEfGhIjKlMnOpQrStUv");
    });
  });

  describe("index shape", () => {
    it("produces a reusable index that can be searched repeatedly", () => {
      const messages: ChatTurnMessage[] = [
        msg("user", "alpha beta"),
        msg("assistant", "gamma beta"),
      ];
      const index: TranscriptIndex = indexMessages(messages);

      expect(search(index, "beta")).toHaveLength(2);
      expect(search(index, "alpha")).toHaveLength(1);
      // result objects carry the position index
      const hit = search(index, "gamma")[0]!;
      expect(hit.index).toBe(1);
    });

    it("indexes an empty transcript without error", () => {
      const index = indexMessages([]);
      expect(search(index, "anything")).toEqual([]);
    });
  });
});
