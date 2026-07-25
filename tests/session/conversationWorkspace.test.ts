import { describe, expect, it } from "vitest";

import { createConversationWorkspace } from '../../src/session/conversationWorkspace.js';

describe("conversation workspace", () => {
  it("lists registered conversations and switches the active conversation", () => {
    const workspace = createConversationWorkspace();
    workspace.create({ id: "research", title: "Research notes", messages: [{ role: "user", content: "Investigate." }] });
    workspace.create({ id: "implementation", title: "Implementation", messages: [{ role: "user", content: "Build it." }] });

    expect(workspace.activeId).toBe("research");
    expect(workspace.list()).toEqual([
      { id: "research", title: "Research notes", messageCount: 1, active: true },
      { id: "implementation", title: "Implementation", messageCount: 1, active: false }
    ]);

    expect(workspace.switch("implementation")).toMatchObject({ id: "implementation", title: "Implementation" });
    expect(workspace.activeId).toBe("implementation");
  });

  it("previous toggles between the two most recently active conversations", () => {
    const workspace = createConversationWorkspace();
    workspace.create({ id: "one", title: "One" });
    workspace.create({ id: "two", title: "Two" });

    workspace.switch("two");
    expect(workspace.previous()).toMatchObject({ id: "one" });
    expect(workspace.previous()).toMatchObject({ id: "two" });
  });

  it("clones a deep transcript snapshot into a new active conversation", () => {
    const workspace = createConversationWorkspace();
    const sourceMessages = [{ role: "user" as const, content: "Original question" }];
    workspace.create({ id: "source", title: "Source", messages: sourceMessages });

    const clone = workspace.clone({ id: "fork", title: "Fork" });
    sourceMessages[0]!.content = "Changed outside the workspace";

    expect(clone).toEqual({
      id: "fork",
      title: "Fork",
      messages: [{ role: "user", content: "Original question" }]
    });
    expect(workspace.activeId).toBe("fork");
    expect(workspace.get("source")).toEqual({
      id: "source",
      title: "Source",
      messages: [{ role: "user", content: "Original question" }]
    });

    expect(workspace.rename("fork", "Forked investigation")).toMatchObject({ title: "Forked investigation" });
    expect(workspace.get("source")?.title).toBe("Source");
  });
});
