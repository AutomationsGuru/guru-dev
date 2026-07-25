import { describe, expect, it } from "vitest";

import {
  validatePowerBundle,
  planInstall,
  detectConflicts,
  composePowerBundles,
  type PlanInstallResult,
  type ConflictReport,
  type ComposedPowerBundle
} from '../../src/garage/powerBundleCompose.js';
import {
  PowerBundleSchema,
  type PowerBundle,
  type PowerMcpServerEntry,
  type SteeringDescriptor,
  type HookRegistration
} from '../../src/garage/powerBundleComposeSchema.js';

// -- helpers ----------------------------------------------------------------

function makeBundle(overrides?: Partial<PowerBundle>): PowerBundle {
  return PowerBundleSchema.parse({
    id: "test-bundle",
    label: "Test Bundle",
    ...overrides
  });
}

function makeMcpRef(id: string): PowerMcpServerEntry {
  return { id, ref: `existing-${id}`, category: "tools" } as PowerMcpServerEntry;
}

function makeMcpInline(id: string): PowerMcpServerEntry {
  return { id, transport: "stdio", command: "node", args: ["server.js"], category: "tools" } as PowerMcpServerEntry;
}

function makeSteering(id: string): SteeringDescriptor {
  return { id, label: `Steer ${id}`, trigger: id, template: `[steering] ${id} check`, notes: "" };
}

function makeHook(id: string, event: string = "tool:execute"): HookRegistration {
  return { id, event, handler: `${id}.sh`, notes: "" };
}

// -- schema validation ------------------------------------------------------

describe("PowerBundle schema", () => {
  it("accepts a minimal valid bundle", () => {
    const result = validatePowerBundle({ id: "minimal", label: "Minimal" });
    expect(result.ok).toBe(true);
    expect(result.bundle?.id).toBe("minimal");
  });

  it("rejects a bundle missing its id", () => {
    const result = validatePowerBundle({ label: "No ID" });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("id") || e.includes("Required"))).toBe(true);
  });

  it("rejects a bundle with an empty id", () => {
    const result = validatePowerBundle({ id: "", label: "Empty ID" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-kebab-case id (capitals, dots, underscores)", () => {
    const result = validatePowerBundle({ id: "Bad_ID.here", label: "Bad Slug" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("accepts a full power bundle with mcpServers, steering, and hooks", () => {
    const result = validatePowerBundle({
      id: "full-power",
      label: "Full Power Bundle",
      version: "1.0.0",
      mcpServers: [
        { id: "filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], category: "tools" },
        { id: "supabase", ref: "supabase-prod", category: "data" }
      ],
      steering: [
        { id: "focus-parser", label: "Focus parser", trigger: "parse-error", template: "The parser hit an error — check the AST shape." }
      ],
      hooks: [
        { id: "log-start", event: "session:start", handler: "log-start.sh" },
        { id: "audit-tool", event: "tool:execute", handler: "audit-tool.sh" }
      ],
      notes: "Demonstrates all fields."
    });
    expect(result.ok).toBe(true);
    const b = result.bundle!;
    expect(b.mcpServers).toHaveLength(2);
    expect(b.steering).toHaveLength(1);
    expect(b.hooks).toHaveLength(2);
  });

  it("rejects an inline MCP entry with no transport", () => {
    const result = validatePowerBundle({
      id: "bad-mcp",
      label: "Bad MCP",
      mcpServers: [{ id: "ghost", category: "tools" }]
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("transport"))).toBe(true);
  });

  it("rejects a stdio MCP entry with no command", () => {
    const result = validatePowerBundle({
      id: "bad-stdio",
      label: "Bad Stdio",
      mcpServers: [{ id: "ghost", transport: "stdio", category: "tools" }]
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("command"))).toBe(true);
  });

  it("rejects an http MCP entry with no url", () => {
    const result = validatePowerBundle({
      id: "bad-http",
      label: "Bad HTTP",
      mcpServers: [{ id: "ghost", transport: "http", category: "tools" }]
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("url") || e.includes("URL"))).toBe(true);
  });

  it("accepts an MCP ref entry with no transport or command", () => {
    const result = validatePowerBundle({
      id: "ref-only",
      label: "Ref Only",
      mcpServers: [{ id: "supabase", ref: "supabase-prod", category: "data" }]
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid lifecycle event name in a hook", () => {
    const result = validatePowerBundle({
      id: "bad-hook",
      label: "Bad Hook",
      hooks: [{ id: "h1", event: "fake:event", handler: "x.sh" }]
    });
    expect(result.ok).toBe(false);
  });
});

// -- planInstall ------------------------------------------------------------

describe("planInstall", () => {
  it("returns an empty plan for a bundle with no extras", () => {
    const plan = planInstall(makeBundle({ id: "bare" }));
    expect(plan.bundleId).toBe("bare");
    expect(plan.entries).toHaveLength(0);
  });

  it("plans install paths for MCP servers (ref entries)", () => {
    const bundle = makeBundle({
      id: "with-mcp",
      mcpServers: [makeMcpRef("filesystem"), makeMcpRef("github")]
    });
    const plan = planInstall(bundle);
    expect(plan.entries).toHaveLength(2);
    const paths = plan.entries.map((e) => e.targetPath);
    expect(paths).toContain(".guru/mcp/filesystem.json");
    expect(paths).toContain(".guru/mcp/github.json");
    plan.entries.forEach((e) => {
      expect(e.component).toBe("mcp-server");
    });
  });

  it("plans install paths for steering rules", () => {
    const bundle = makeBundle({
      id: "with-steer",
      steering: [makeSteering("focus-parser"), makeSteering("lint-watch")]
    });
    const plan = planInstall(bundle);
    expect(plan.entries).toHaveLength(2);
    const paths = plan.entries.map((e) => e.targetPath);
    expect(paths).toContain(".guru/steering/focus-parser.json");
    expect(paths).toContain(".guru/steering/lint-watch.json");
  });

  it("plans install paths for hooks", () => {
    const bundle = makeBundle({
      id: "with-hooks",
      hooks: [makeHook("log-start", "session:start"), makeHook("audit", "tool:execute")]
    });
    const plan = planInstall(bundle);
    expect(plan.entries).toHaveLength(2);
    const paths = plan.entries.map((e) => e.targetPath);
    expect(paths).toContain(".guru/hooks/log-start.sh");
    expect(paths).toContain(".guru/hooks/audit.sh");
    plan.entries.forEach((e) => {
      expect(e.artifactKind).toBe("script");
    });
  });

  it("plans install paths for a full bundle with all three extras", () => {
    const bundle = makeBundle({
      id: "full",
      mcpServers: [makeMcpRef("db")],
      steering: [makeSteering("focus")],
      hooks: [makeHook("on-start", "session:start")]
    });
    const plan = planInstall(bundle);
    expect(plan.entries).toHaveLength(3);
    const byComponent = (c: string) => plan.entries.filter((e) => e.component === c);
    expect(byComponent("mcp-server")).toHaveLength(1);
    expect(byComponent("steering")).toHaveLength(1);
    expect(byComponent("hook")).toHaveLength(1);
  });
});

// -- conflict detection -----------------------------------------------------

describe("detectConflicts", () => {
  it("returns no conflicts for a single bundle", () => {
    const report = detectConflicts([makeBundle({ id: "solo" })]);
    expect(report.hasConflicts).toBe(false);
    expect(report.conflicts).toHaveLength(0);
  });

  it("returns no conflicts for two disjoint bundles", () => {
    const a = makeBundle({
      id: "bundle-a",
      mcpServers: [makeMcpRef("filesystem")],
      steering: [makeSteering("focus-a")],
      hooks: [makeHook("hook-a", "session:start")]
    });
    const b = makeBundle({
      id: "bundle-b",
      mcpServers: [makeMcpRef("github")],
      steering: [makeSteering("focus-b")],
      hooks: [makeHook("hook-b", "tool:execute")]
    });
    const report = detectConflicts([a, b]);
    expect(report.hasConflicts).toBe(false);
  });

  it("detects duplicate MCP server ids across bundles", () => {
    const a = makeBundle({ id: "a", mcpServers: [makeMcpRef("filesystem")] });
    const b = makeBundle({ id: "b", mcpServers: [makeMcpRef("filesystem")] });
    const report = detectConflicts([a, b]);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]!.kind).toBe("duplicate-mcp-server");
    expect(report.conflicts[0]!.path).toBe(".guru/mcp/filesystem.json");
    expect(report.conflicts[0]!.detail).toContain("filesystem");
    expect(report.conflicts[0]!.detail).toContain("a");
    expect(report.conflicts[0]!.detail).toContain("b");
  });

  it("detects duplicate steering ids across bundles", () => {
    const a = makeBundle({ id: "a", steering: [makeSteering("focus")] });
    const b = makeBundle({ id: "b", steering: [makeSteering("focus")] });
    const report = detectConflicts([a, b]);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts[0]!.kind).toBe("duplicate-steering");
    expect(report.conflicts[0]!.path).toBe(".guru/steering/focus.json");
  });

  it("detects duplicate hooks (same event + handler) across bundles", () => {
    const a = makeBundle({ id: "a", hooks: [makeHook("h1", "tool:execute")] });
    const b = makeBundle({ id: "b", hooks: [makeHook("h2", "tool:execute")] });
    // Different ids but same event+handler → conflict
    const a2 = makeBundle({
      id: "a2",
      hooks: [{ id: "dup", event: "session:start", handler: "start.sh", notes: "" }]
    });
    const b2 = makeBundle({
      id: "b2",
      hooks: [{ id: "other", event: "session:start", handler: "start.sh", notes: "" }]
    });
    const report = detectConflicts([a2, b2]);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts[0]!.kind).toBe("duplicate-hook");
    expect(report.conflicts[0]!.path).toBe(".guru/hooks/start.sh");
  });

  it("detects no hook conflict when same event but different handlers", () => {
    const a = makeBundle({ id: "a", hooks: [makeHook("h1", "session:start")] });
    const b = makeBundle({ id: "b", hooks: [{ id: "h2", event: "session:start", handler: "other.sh", notes: "" }] });
    const report = detectConflicts([a, b]);
    expect(report.hasConflicts).toBe(false);
  });

  it("detects MCP ref-vs-inline conflict kind", () => {
    const a = makeBundle({ id: "a", mcpServers: [makeMcpRef("db")] });
    const b = makeBundle({ id: "b", mcpServers: [makeMcpInline("db")] });
    const report = detectConflicts([a, b]);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts[0]!.kind).toBe("mcp-ref-vs-inline");
  });

  it("reports all conflicts across three bundles", () => {
    const a = makeBundle({
      id: "a",
      mcpServers: [makeMcpRef("shared-db")],
      steering: [makeSteering("focus")],
      hooks: [makeHook("on-start", "session:start")]
    });
    const b = makeBundle({
      id: "b",
      mcpServers: [makeMcpRef("shared-db")],
      steering: [makeSteering("focus")],
      hooks: [makeHook("on-start", "session:start")]
    });
    const c = makeBundle({
      id: "c",
      mcpServers: [makeMcpRef("shared-db")],
      steering: [makeSteering("other")],
      hooks: [makeHook("on-start", "session:start")]
    });
    const report = detectConflicts([a, b, c]);
    // a-b: mcp + steer + hook = 3; a-c: mcp + hook = 2; b-c: mcp + hook = 2
    expect(report.conflicts.length).toBeGreaterThanOrEqual(5);
  });
});

// -- compose -----------------------------------------------------------------

describe("composePowerBundles", () => {
  it("merges disjoint bundles with no conflicts", () => {
    const a = makeBundle({
      id: "bundle-a",
      mcpServers: [makeMcpRef("filesystem")],
      steering: [makeSteering("focus-a")]
    });
    const b = makeBundle({
      id: "bundle-b",
      mcpServers: [makeMcpRef("github")],
      hooks: [makeHook("log-start", "session:start")]
    });
    const composed = composePowerBundles([a, b]);
    expect(composed.bundleIds).toEqual(["bundle-a", "bundle-b"]);
    expect(composed.mcpServers).toHaveLength(2);
    expect(composed.steering).toHaveLength(1);
    expect(composed.hooks).toHaveLength(1);
    expect(composed.conflicts).toHaveLength(0);
  });

  it("earliest bundle wins on MCP server id conflict", () => {
    const a = makeBundle({ id: "a", mcpServers: [makeMcpRef("db")] });
    const b = makeBundle({ id: "b", mcpServers: [makeMcpInline("db")] });
    const composed = composePowerBundles([a, b]);
    // Earliest wins: a's ref entry kept, b's inline dropped.
    expect(composed.mcpServers).toHaveLength(1);
    expect(composed.mcpServers[0]!.ref).toBe("existing-db");
    expect(composed.conflicts.length).toBeGreaterThan(0);
  });

  it("reports conflicts while still merging", () => {
    const a = makeBundle({ id: "a", steering: [makeSteering("focus")] });
    const b = makeBundle({ id: "b", steering: [makeSteering("focus")] });
    const composed = composePowerBundles([a, b]);
    // Merged: only one steering entry (earliest).
    expect(composed.steering).toHaveLength(1);
    // Reported: one conflict.
    expect(composed.conflicts).toHaveLength(1);
  });

  it("handles an empty bundle list", () => {
    const composed = composePowerBundles([]);
    expect(composed.bundleIds).toHaveLength(0);
    expect(composed.mcpServers).toHaveLength(0);
    expect(composed.conflicts).toHaveLength(0);
  });
});
