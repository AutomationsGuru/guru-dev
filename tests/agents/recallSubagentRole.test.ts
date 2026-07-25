import { describe, it, expect } from "vitest";

import {
  isAllowed,
  RECALL_SUBAGENT_TOOL_ALLOWLIST
} from '../../src/agents/recallSubagentRole.js';

describe("recallSubagentRole", () => {
  it("allows read-only memory/search tools", () => {
    expect(isAllowed("memory_search")).toBe(true);
    expect(isAllowed("memory_get")).toBe(true);
    expect(isAllowed("memory_status")).toBe(true);
    expect(isAllowed("memory_doctor")).toBe(true);
    expect(isAllowed("read")).toBe(true);
  });

  it("denies write and shell tools", () => {
    expect(isAllowed("memory_remember")).toBe(false);
    expect(isAllowed("memory_forget")).toBe(false);
    expect(isAllowed("bash")).toBe(false);
    expect(isAllowed("edit")).toBe(false);
    expect(isAllowed("write")).toBe(false);
    expect(isAllowed("spawn_agent")).toBe(false);
    expect(isAllowed("kill_task")).toBe(false);
  });

  it("exposes the allowlist for inspection", () => {
    expect(RECALL_SUBAGENT_TOOL_ALLOWLIST).toContain("memory_search");
    expect(RECALL_SUBAGENT_TOOL_ALLOWLIST.length).toBeGreaterThan(0);
    // no write tools in list
    expect(RECALL_SUBAGENT_TOOL_ALLOWLIST).not.toContain("memory_remember");
  });
});
