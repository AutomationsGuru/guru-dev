import { describe, expect, it } from "vitest";

import {
  createDirectoryConversationAffinity,
  pickLastForDir
} from '../../src/session/directoryConversationAffinity.js';

describe("directory conversation affinity (IDEA-F146-DIR-CONV-01 / R-KR-DIRCONV)", () => {
  it("returns null for an unknown directory", () => {
    const affinity = createDirectoryConversationAffinity();
    expect(affinity.lastFor("/tmp/never-seen")).toBeNull();
    expect(pickLastForDir(affinity, "/tmp/never-seen")).toBeNull();
  });

  it("recalls the recorded conversation for a directory", () => {
    const affinity = createDirectoryConversationAffinity();
    affinity.record("/repo/alpha", "conv-1");
    expect(affinity.lastFor("/repo/alpha")).toBe("conv-1");
  });

  it("returns the most recently recorded conversation for a directory", () => {
    const affinity = createDirectoryConversationAffinity();
    affinity.record("/repo/alpha", "conv-1");
    affinity.record("/repo/alpha", "conv-2");
    expect(affinity.lastFor("/repo/alpha")).toBe("conv-2");
  });

  it("keeps affinity per directory", () => {
    const affinity = createDirectoryConversationAffinity();
    affinity.record("/repo/alpha", "conv-a");
    affinity.record("/repo/beta", "conv-b");
    expect(affinity.lastFor("/repo/alpha")).toBe("conv-a");
    expect(affinity.lastFor("/repo/beta")).toBe("conv-b");
  });

  it("normalizes paths: separators, dot segments, and trailing slashes match", () => {
    const affinity = createDirectoryConversationAffinity();
    affinity.record("/repo/./alpha/", "conv-1");
    expect(affinity.lastFor("/repo/alpha")).toBe("conv-1");
    expect(affinity.lastFor("/repo//alpha//")).toBe("conv-1");
    expect(pickLastForDir(affinity, "/repo/alpha/")).toBe("conv-1");
  });

  it("normalizes relative paths against an explicit cwd", () => {
    const affinity = createDirectoryConversationAffinity({ cwd: "/repo" });
    affinity.record("./alpha", "conv-1");
    expect(affinity.lastFor("/repo/alpha")).toBe("conv-1");
    expect(affinity.lastFor("alpha")).toBe("conv-1");
  });

  it("treats differing directory case as the same directory", () => {
    const affinity = createDirectoryConversationAffinity();
    affinity.record("/Repo/Alpha", "conv-1");
    expect(affinity.lastFor("/repo/alpha")).toBe("conv-1");
  });

  it("ignores blank dirs and conversation ids", () => {
    const affinity = createDirectoryConversationAffinity();
    affinity.record("   ", "conv-1");
    affinity.record("/repo/alpha", "  ");
    expect(affinity.lastFor("/repo/alpha")).toBeNull();
  });

  it("pickLastForDir returns null for a blank directory", () => {
    const affinity = createDirectoryConversationAffinity();
    expect(pickLastForDir(affinity, "")).toBeNull();
    expect(pickLastForDir(affinity, "   ")).toBeNull();
  });
});
