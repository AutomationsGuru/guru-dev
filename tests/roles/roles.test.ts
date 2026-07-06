import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryStore, type FileMemoryStore } from "../../src/memory/store.js";
import { assembleSuit, verifyModelForRole } from "../../src/roles/assemble.js";
import { RoleProfileSchema, slugifyRole, type RoleProfile } from "../../src/roles/schema.js";
import { listRoles, loadRole, parkRole } from "../../src/roles/store.js";
import { ProviderRouteDescriptorSchema } from "../../src/providers/schemas.js";

const dirs: string[] = [];

function makeMemory(): FileMemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "guru-roles-"));
  dirs.push(dir);
  return createFileMemoryStore({ directory: dir });
}

function makeRole(overrides: Partial<RoleProfile> = {}): RoleProfile {
  return RoleProfileSchema.parse({
    slug: "finance",
    label: "finances",
    capabilityMode: "all",
    tools: [],
    skills: [],
    extensions: [],
    mcpServers: [],
    modelPreference: { requires: ["chat", "tools"] },
    verifiedTools: [],
    wornCount: 1,
    notes: "",
    ...overrides
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("slugifyRole — intake text to suit name", () => {
  it("strips filler words and derives a stable slug", () => {
    expect(slugifyRole("we're doing finances today")).toBe("finances");
    expect(slugifyRole("Email triage!")).toBe("email-triage");
    expect(slugifyRole("working on the Q3 budget")).toBe("the-q3-budget");
  });

  it("same intake next session hits the same suit", () => {
    expect(slugifyRole("we're doing finances today")).toBe(slugifyRole("finances"));
  });
});

describe("role store — parks as loadout memory facts (the garage substrate)", () => {
  it("park -> load round-trips the profile through a memory fact", () => {
    const memory = makeMemory();
    const role = makeRole({ verifiedTools: ["memory_search"], notes: "the finance suit" });
    parkRole(memory, role);

    const loaded = loadRole(memory, "finance");
    expect(loaded).toEqual(role);

    // It IS a memory fact — visible in the garage listing and the index.
    expect(listRoles(memory)).toHaveLength(1);
    const fact = memory.get("role-finance");
    expect(fact.found).toBe(true);
    expect(fact.fact?.type).toBe("loadout");
  });

  it("re-parking updates in place (update-not-duplicate)", () => {
    const memory = makeMemory();
    parkRole(memory, makeRole());
    parkRole(memory, makeRole({ wornCount: 3, verifiedTools: ["memory_search", "memory_get"] }));
    expect(listRoles(memory)).toHaveLength(1);
    expect(loadRole(memory, "finance")?.wornCount).toBe(3);
    expect(loadRole(memory, "finance")?.verifiedTools).toContain("memory_get");
  });

  it("missing suit loads undefined (naked assembly path)", () => {
    expect(loadRole(makeMemory(), "never-worn")).toBeUndefined();
  });
});

describe("assembleSuit — selection only, gates survive", () => {
  const registered = new Set(["read", "bash", "edit", "write", "memory_search", "memory_get", "memory_remember", "git.pr.run"]);
  const readOnly = new Set(["read", "memory_search", "memory_get"]);

  it("'all' suits get the core floor + selected + verified tools", () => {
    const suit = assembleSuit(makeRole({ tools: ["memory_search"], verifiedTools: ["memory_remember"] }), registered, readOnly);
    for (const id of ["read", "bash", "edit", "write", "memory_search", "memory_remember"]) {
      expect(suit.chatToolIds.has(id), id).toBe(true);
    }
    expect(suit.chatToolIds.has("git.pr.run")).toBe(false); // not selected
  });

  it("read-only suits physically cannot offer mutating tools", () => {
    const suit = assembleSuit(makeRole({ capabilityMode: "read-only", tools: ["memory_search", "memory_remember", "bash"] }), registered, readOnly);
    expect(suit.chatToolIds.has("read")).toBe(true);
    expect(suit.chatToolIds.has("memory_search")).toBe(true);
    expect(suit.chatToolIds.has("memory_remember")).toBe(false);
    expect(suit.chatToolIds.has("bash")).toBe(false);
    expect(suit.chatToolIds.has("write")).toBe(false);
  });

  it("unregistered selections surface as missing, never silently", () => {
    const suit = assembleSuit(makeRole({ tools: ["web_search"] }), registered, readOnly);
    expect(suit.missingTools).toContain("web_search");
  });
});

describe("verifyModelForRole — the day's model must satisfy the suit", () => {
  const route = ProviderRouteDescriptorSchema.parse({
    providerId: "test",
    modelId: "m",
    routeId: "test/m",
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://example.invalid/v1",
    credentialSource: { type: "none", envVarNames: [] },
    capabilities: { supportsTools: true, supportsVision: false, supportsReasoning: true },
    status: "ready-unverified",
    directFirstRank: 1,
    allowedRouterFallback: false
  });

  it("passes when requirements are met, names what's unmet otherwise", () => {
    expect(verifyModelForRole(makeRole(), route).ok).toBe(true);
    const vision = verifyModelForRole(makeRole({ modelPreference: { requires: ["chat", "tools", "vision"] } }), route);
    expect(vision.ok).toBe(false);
    expect(vision.unmet).toEqual(["vision"]);
    expect(verifyModelForRole(makeRole(), null).ok).toBe(false);
  });
});

describe("garage deepening (Phase E) — staleness + path-outcomes", () => {
  it("roleAgeDays computes age from the fact's park time; stale threshold surfaces", async () => {
    const { roleAgeDays, ROLE_STALE_AFTER_DAYS } = await import("../../src/roles/store.js");
    const memory = makeMemory();
    parkRole(memory, makeRole());
    const fresh = roleAgeDays(memory, "finance", () => new Date());
    expect(fresh).toBe(0);
    const future = roleAgeDays(memory, "finance", () => new Date(Date.now() + 20 * 86_400_000));
    expect(future).toBeGreaterThan(ROLE_STALE_AFTER_DAYS);
    expect(roleAgeDays(memory, "never-parked")).toBeUndefined();
  });

  it("path outcomes append per session under one fact, keyed by role", async () => {
    const { recordPathOutcome } = await import("../../src/roles/store.js");
    const memory = makeMemory();
    recordPathOutcome(memory, "finance", { routeId: "test/m", turns: 3, toolsUsed: ["memory_search"] });
    recordPathOutcome(memory, "finance", { routeId: "test/m2", turns: 1, toolsUsed: [] });
    const fact = memory.get("path-outcomes-finance");
    expect(fact.found).toBe(true);
    expect(fact.fact?.type).toBe("path-outcome");
    expect(fact.body).toContain("test/m");
    expect(fact.body).toContain("test/m2"); // appended, not replaced
    expect(memory.list().filter((entry) => entry.fact.type === "path-outcome")).toHaveLength(1);
  });
});
