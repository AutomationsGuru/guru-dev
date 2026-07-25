import { describe, expect, it } from "vitest";

import {
  createTranscriptAnchorBookmarks,
  type AnchorableMessage
} from '../../src/session/transcriptAnchorBookmark.js';

interface SampleMessage extends AnchorableMessage {
  readonly text: string;
}

function messages(...entries: Array<[string, string]>): SampleMessage[] {
  return entries.map(([id, text]) => ({ id, text }));
}

describe("createTranscriptAnchorBookmarks", () => {
  it("starts empty and lists nothing", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    expect(bookmarks.list()).toEqual([]);
  });

  it("stores and retrieves a bookmark by message id", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("anchor", "msg-3");
    expect(bookmarks.get("anchor")).toBe("msg-3");
  });

  it("overwrites an existing bookmark name in place", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("anchor", "msg-1");
    bookmarks.set("anchor", "msg-7");
    expect(bookmarks.get("anchor")).toBe("msg-7");
    expect(bookmarks.list()).toHaveLength(1);
  });

  it("deletes a bookmark", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("anchor", "msg-3");
    expect(bookmarks.delete("anchor")).toBe(true);
    expect(bookmarks.get("anchor")).toBeUndefined();
    expect(bookmarks.list()).toEqual([]);
  });

  it("reports delete=false for a missing bookmark", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    expect(bookmarks.delete("nope")).toBe(false);
  });

  it("lists bookmarks in stable insertion order", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("alpha", "msg-1");
    bookmarks.set("beta", "msg-2");
    bookmarks.set("gamma", "msg-3");
    // Overwriting an existing name keeps its original insertion position.
    bookmarks.set("beta", "msg-9");
    expect(bookmarks.list()).toEqual([
      { name: "alpha", messageId: "msg-1" },
      { name: "beta", messageId: "msg-9" },
      { name: "gamma", messageId: "msg-3" }
    ]);
  });

  it("resolve returns the matching message object without mutating the transcript", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("anchor", "msg-2");
    const transcript = messages(["msg-1", "a"], ["msg-2", "b"], ["msg-3", "c"]);
    const snapshot = transcript.map((m) => ({ ...m }));
    const resolved = bookmarks.resolve("anchor", transcript);
    expect(resolved).toEqual({ id: "msg-2", text: "b" });
    // Transcript body untouched: same length and same contents.
    expect(transcript).toEqual(snapshot);
    expect(transcript).toHaveLength(3);
  });

  it("resolve fails closed (undefined) when the bookmark is missing", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("anchor", "msg-1");
    const transcript = messages(["msg-1", "a"]);
    expect(bookmarks.resolve("missing", transcript)).toBeUndefined();
  });

  it("resolve fails closed (undefined) when the anchored message id is absent from the transcript", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("anchor", "msg-gone");
    const transcript = messages(["msg-1", "a"], ["msg-2", "b"]);
    expect(bookmarks.resolve("anchor", transcript)).toBeUndefined();
  });

  it("resolve fails closed (undefined) for an empty transcript", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("anchor", "msg-1");
    expect(bookmarks.resolve("anchor", [])).toBeUndefined();
  });

  it("rejects an empty bookmark name (fail closed, throws)", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    expect(() => bookmarks.set("", "msg-1")).toThrow();
    expect(bookmarks.list()).toEqual([]);
  });

  it("rejects a whitespace-only bookmark name (fail closed, throws)", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    expect(() => bookmarks.set("   ", "msg-1")).toThrow();
    expect(bookmarks.list()).toEqual([]);
  });

  it("trims surrounding whitespace from bookmark names", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("  anchor  ", "msg-1");
    expect(bookmarks.get("anchor")).toBe("msg-1");
    expect(bookmarks.list()).toEqual([{ name: "anchor", messageId: "msg-1" }]);
  });

  it("resolveAll maps every bookmark to its resolved message, skipping anchors whose id is absent", () => {
    const bookmarks = createTranscriptAnchorBookmarks();
    bookmarks.set("alpha", "msg-1");
    bookmarks.set("beta", "msg-missing");
    bookmarks.set("gamma", "msg-3");
    const transcript = messages(["msg-1", "a"], ["msg-3", "c"]);
    const resolved = bookmarks.resolveAll(transcript);
    expect(resolved).toEqual([
      { name: "alpha", messageId: "msg-1", message: { id: "msg-1", text: "a" } },
      { name: "gamma", messageId: "msg-3", message: { id: "msg-3", text: "c" } }
    ]);
  });
});
