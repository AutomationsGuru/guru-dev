import { describe, expect, it } from "vitest";

import { resolveToolApprovalMode } from '../../src/mandates/toolApprovalModeTable.js';
import type { ToolApprovalModeTable } from '../../src/mandates/toolApprovalModeTable.js';

const empty: ToolApprovalModeTable = {};
const sample: ToolApprovalModeTable = { bash: "auto", write: "ask", web_fetch: "deny" };

describe("resolveToolApprovalMode", () => {
  describe("default ask (fail-closed)", () => {
    it("empty table → ask for every tool class", () => {
      expect(resolveToolApprovalMode("bash", empty)).toBe("ask");
      expect(resolveToolApprovalMode("write", empty)).toBe("ask");
      expect(resolveToolApprovalMode("edit", empty)).toBe("ask");
      expect(resolveToolApprovalMode("web_fetch", empty)).toBe("ask");
      expect(resolveToolApprovalMode("web_search", empty)).toBe("ask");
      expect(resolveToolApprovalMode("git.pr.run", empty)).toBe("ask");
      expect(resolveToolApprovalMode("provider_cli_run", empty)).toBe("ask");
      expect(resolveToolApprovalMode("mcp.use_tool", empty)).toBe("ask");
    });

    it("unknown tool class in a populated table → ask (not auto, not deny)", () => {
      expect(resolveToolApprovalMode("edit", sample)).toBe("ask");
      expect(resolveToolApprovalMode("web_search", sample)).toBe("ask");
      expect(resolveToolApprovalMode("git.pr.run", sample)).toBe("ask");
      expect(resolveToolApprovalMode("honcho_remember", sample)).toBe("ask");
      expect(resolveToolApprovalMode("nonexistent_tool", sample)).toBe("ask");
    });

    it("default ask is fail-closed — never weakens to auto or deny for absent entries", () => {
      // A table that auto-approves bash should NOT leak auto to any other tool.
      const bashOnly: ToolApprovalModeTable = { bash: "auto" };
      for (const tool of ["write", "edit", "web_fetch", "web_search", "git.pr.run"]) {
        expect(resolveToolApprovalMode(tool, bashOnly)).toBe("ask");
      }
    });
  });

  describe("exact match", () => {
    it("returns the configured mode for each tool class in the table", () => {
      expect(resolveToolApprovalMode("bash", sample)).toBe("auto");
      expect(resolveToolApprovalMode("write", sample)).toBe("ask");
      expect(resolveToolApprovalMode("web_fetch", sample)).toBe("deny");
    });

    it("distinguishes each mode independently", () => {
      const table: ToolApprovalModeTable = {
        read: "auto",
        find: "auto",
        bash: "ask",
        edit: "deny",
        "git.pr.run": "deny"
      };
      expect(resolveToolApprovalMode("read", table)).toBe("auto");
      expect(resolveToolApprovalMode("find", table)).toBe("auto");
      expect(resolveToolApprovalMode("bash", table)).toBe("ask");
      expect(resolveToolApprovalMode("edit", table)).toBe("deny");
      expect(resolveToolApprovalMode("git.pr.run", table)).toBe("deny");
    });

    it("a table entry of 'ask' is explicit (not a default fallthrough)", () => {
      // "ask" in the table means the operator chose "ask" — it's not the same as
      // an absent key (which also resolves to "ask" by default). The resolution
      // is the same, but the entry is distinct.
      const table: ToolApprovalModeTable = { bash: "ask" };
      expect(resolveToolApprovalMode("bash", table)).toBe("ask");
      expect(resolveToolApprovalMode("write", table)).toBe("ask");
    });
  });

  describe("fidelity", () => {
    it("returns the literal mode string (auto | ask | deny) — no other values", () => {
      const table: ToolApprovalModeTable = { a: "auto", b: "ask", c: "deny" };
      const modes = new Set(["auto", "ask", "deny"]);
      expect(modes.has(resolveToolApprovalMode("a", table))).toBe(true);
      expect(modes.has(resolveToolApprovalMode("b", table))).toBe(true);
      expect(modes.has(resolveToolApprovalMode("c", table))).toBe(true);
      expect(modes.has(resolveToolApprovalMode("d", table))).toBe(true); // default "ask"
    });

    it("table is not mutated by resolution (readonly)", () => {
      const table: ToolApprovalModeTable = { bash: "auto" };
      const frozen = { ...table };
      resolveToolApprovalMode("bash", table);
      resolveToolApprovalMode("write", table);
      resolveToolApprovalMode("edit", table);
      expect(table).toEqual(frozen);
    });
  });
});
