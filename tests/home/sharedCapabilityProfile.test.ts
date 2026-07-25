import {
  AgentIdSchema,
  CapabilityProfileIdSchema,
  CapabilityProfileNotFoundError,
  CapabilityProfileSchema,
  type CapabilityProfile,
  type SharedCapabilityProfileRegistry,
  bindAgentToProfile,
  createCapabilityProfile,
  createEmptyCapabilityProfileRegistry,
  listAgentsForProfile,
  resolveAgentCapability,
  unbindAgent
} from '../../src/home/sharedCapabilityProfile.js';

describe("Shared capability profile", () => {
  describe("headline: two agents share one profile by reference", () => {
    it("binds two agents to one profile and resolves identical capability arrays (referential equality)", () => {
      const profile: CapabilityProfile = {
        profileId: "researchers",
        label: "Research cohort",
        skills: ["s1", "s2"],
        mcpServers: ["mcp-a"],
        extensions: [],
        notes: ""
      };

      let registry = createEmptyCapabilityProfileRegistry();
      registry = createCapabilityProfile(registry, profile);
      registry = bindAgentToProfile(registry, "agent-1", "researchers");
      registry = bindAgentToProfile(registry, "agent-2", "researchers");

      const r1 = resolveAgentCapability(registry, "agent-1");
      const r2 = resolveAgentCapability(registry, "agent-2");

      expect(r1.found).toBe(true);
      expect(r2.found).toBe(true);
      if (!r1.found || !r2.found) return;

      expect(r1.skills).toEqual(["s1", "s2"]);
      expect(r2.skills).toEqual(["s1", "s2"]);
      // Headline invariant: SAME array instance, not a copy.
      expect(r1.skills).toBe(r2.skills);

      expect(r1.mcpServers).toEqual(["mcp-a"]);
      expect(r2.mcpServers).toEqual(["mcp-a"]);
      expect(r1.mcpServers).toBe(r2.mcpServers);

      expect(r1.extensions).toBe(r2.extensions);

      expect(listAgentsForProfile(registry, "researchers")).toEqual(["agent-1", "agent-2"]);
    });
  });

  describe("createCapabilityProfile", () => {
    it("dedupes skills deterministically in first-seen order", () => {
      const registry = createCapabilityProfile(createEmptyCapabilityProfileRegistry(), {
        profileId: "p",
        label: "P",
        skills: ["s2", "s1", "s2", "s1"],
        mcpServers: [],
        extensions: [],
        notes: ""
      });

      const profile = registry.profiles.get("p");
      expect(profile?.skills).toEqual(["s2", "s1"]);
    });

    it("applies schema defaults for omitted optional fields", () => {
      const parsed = CapabilityProfileSchema.parse({
        profileId: "minimal",
        label: "Minimal"
      });
      expect(parsed.skills).toEqual([]);
      expect(parsed.mcpServers).toEqual([]);
      expect(parsed.extensions).toEqual([]);
      expect(parsed.notes).toBe("");
    });

    it("freezes stored arrays so shared references stay safe", () => {
      const registry = createCapabilityProfile(createEmptyCapabilityProfileRegistry(), {
        profileId: "p",
        label: "P",
        skills: ["s1"],
        mcpServers: ["mcp-a"],
        extensions: ["ext-1"],
        notes: ""
      });

      const profile = registry.profiles.get("p")!;
      expect(Object.isFrozen(profile.skills)).toBe(true);
      expect(Object.isFrozen(profile.mcpServers)).toBe(true);
      expect(Object.isFrozen(profile.extensions)).toBe(true);
    });

    it("replaces an existing profile on re-create (insert-or-replace)", () => {
      let registry = createEmptyCapabilityProfileRegistry();
      registry = createCapabilityProfile(registry, {
        profileId: "p",
        label: "Original",
        skills: ["s1"],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      registry = createCapabilityProfile(registry, {
        profileId: "p",
        label: "Refreshed",
        skills: ["s2"],
        mcpServers: [],
        extensions: [],
        notes: ""
      });

      const profile = registry.profiles.get("p")!;
      expect(profile.label).toBe("Refreshed");
      expect(profile.skills).toEqual(["s2"]);
    });

    it("rejects an invalid profile via zod (missing required field)", () => {
      expect(() =>
        createCapabilityProfile(createEmptyCapabilityProfileRegistry(), {
          profileId: "p",
          label: "",
          skills: [],
          mcpServers: [],
          extensions: [],
          notes: ""
        })
      ).toThrow();
    });

    it("rejects an extra property (strict schema)", () => {
      expect(() =>
        CapabilityProfileSchema.parse({
          profileId: "p",
          label: "P",
          skills: [],
          mcpServers: [],
          extensions: [],
          notes: "",
          unexpected: true
        })
      ).toThrow();
    });
  });

  describe("bindAgentToProfile", () => {
    it("throws CapabilityProfileNotFoundError when the profile does not exist", () => {
      const empty = createEmptyCapabilityProfileRegistry();
      try {
        bindAgentToProfile(empty, "agent-x", "nope");
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilityProfileNotFoundError);
        expect((error as CapabilityProfileNotFoundError).code).toBe("capability_profile_not_found");
        expect((error as Error).message).toContain("nope");
      }
    });

    it("validates agentId shape", () => {
      const registry = createCapabilityProfile(createEmptyCapabilityProfileRegistry(), {
        profileId: "p",
        label: "P",
        skills: [],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      expect(() => bindAgentToProfile(registry, "BAD ID", "p")).toThrow();
    });

    it("validates profileId shape on the binding", () => {
      const registry = createCapabilityProfile(createEmptyCapabilityProfileRegistry(), {
        profileId: "p",
        label: "P",
        skills: [],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      expect(() => bindAgentToProfile(registry, "agent-1", "BAD ID")).toThrow();
    });
  });

  describe("resolveAgentCapability", () => {
    it("returns { found: false } for an unbound agent", () => {
      const registry = createEmptyCapabilityProfileRegistry();
      expect(resolveAgentCapability(registry, "ghost")).toEqual({ found: false });
    });

    it("returns { found: false } for a stale binding (profile missing from registry)", () => {
      // Build a valid registry: profile P exists, agent A bound to P.
      const withProfile = createCapabilityProfile(createEmptyCapabilityProfileRegistry(), {
        profileId: "p",
        label: "P",
        skills: ["s1"],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      const withBinding = bindAgentToProfile(withProfile, "a", "p");

      // Stale registry: binding present, profile absent. Constructing a literal
      // is allowed because the registry is a plain exported interface.
      const stale: SharedCapabilityProfileRegistry = {
        profiles: new Map(),
        bindings: withBinding.bindings
      };

      expect(resolveAgentCapability(stale, "a")).toEqual({ found: false });
    });

    it("returns frozen arrays so external mutation cannot corrupt the shared profile", () => {
      const registry = createCapabilityProfile(createEmptyCapabilityProfileRegistry(), {
        profileId: "p",
        label: "P",
        skills: ["s1"],
        mcpServers: ["mcp-a"],
        extensions: [],
        notes: ""
      });
      const bound = bindAgentToProfile(registry, "a", "p");
      const r = resolveAgentCapability(bound, "a");
      if (!r.found) throw new Error("expected found");
      expect(Object.isFrozen(r.skills)).toBe(true);
      expect(Object.isFrozen(r.mcpServers)).toBe(true);
      expect(Object.isFrozen(r.extensions)).toBe(true);
    });
  });

  describe("rebind changes the bound profile", () => {
    it("moves an agent from P1 to P2 and updates listAgentsForProfile accordingly", () => {
      let registry = createEmptyCapabilityProfileRegistry();
      registry = createCapabilityProfile(registry, {
        profileId: "p1",
        label: "One",
        skills: ["s-1"],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      registry = createCapabilityProfile(registry, {
        profileId: "p2",
        label: "Two",
        skills: ["s-2"],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      registry = bindAgentToProfile(registry, "a", "p1");
      registry = bindAgentToProfile(registry, "a", "p2");

      const r = resolveAgentCapability(registry, "a");
      expect(r.found).toBe(true);
      if (!r.found) return;
      expect(r.skills).toEqual(["s-2"]);

      expect(listAgentsForProfile(registry, "p1")).toEqual([]);
      expect(listAgentsForProfile(registry, "p2")).toEqual(["a"]);
    });
  });

  describe("unbindAgent", () => {
    it("removes a binding and is idempotent on subsequent calls", () => {
      let registry = createEmptyCapabilityProfileRegistry();
      registry = createCapabilityProfile(registry, {
        profileId: "p",
        label: "P",
        skills: ["s1"],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      registry = bindAgentToProfile(registry, "a", "p");

      const afterFirst = unbindAgent(registry, "a");
      expect(resolveAgentCapability(afterFirst, "a")).toEqual({ found: false });

      // Idempotent: unbinding again is a no-op.
      const afterSecond = unbindAgent(afterFirst, "a");
      expect(resolveAgentCapability(afterSecond, "a")).toEqual({ found: false });
      expect(Array.from(afterSecond.bindings.keys())).toEqual([]);
    });

    it("is a no-op on a never-bound agent", () => {
      const empty = createEmptyCapabilityProfileRegistry();
      const result = unbindAgent(empty, "ghost");
      expect(Array.from(result.bindings.keys())).toEqual([]);
    });
  });

  describe("listAgentsForProfile", () => {
    it("returns bound agent ids sorted ascending", () => {
      let registry = createEmptyCapabilityProfileRegistry();
      registry = createCapabilityProfile(registry, {
        profileId: "p",
        label: "P",
        skills: [],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      registry = bindAgentToProfile(registry, "agent-c", "p");
      registry = bindAgentToProfile(registry, "agent-a", "p");
      registry = bindAgentToProfile(registry, "agent-b", "p");

      expect(listAgentsForProfile(registry, "p")).toEqual(["agent-a", "agent-b", "agent-c"]);
    });

    it("returns an empty array for an unknown profile", () => {
      expect(listAgentsForProfile(createEmptyCapabilityProfileRegistry(), "nope")).toEqual([]);
    });
  });

  describe("immutability", () => {
    it("transform functions never mutate the input registry", () => {
      const empty = createEmptyCapabilityProfileRegistry();
      const withProfile = createCapabilityProfile(empty, {
        profileId: "p",
        label: "P",
        skills: ["s1"],
        mcpServers: [],
        extensions: [],
        notes: ""
      });
      const withBinding = bindAgentToProfile(withProfile, "a", "p");

      // The original empty registry is untouched.
      expect(empty.profiles.size).toBe(0);
      expect(empty.bindings.size).toBe(0);
      // Each step returns a new container.
      expect(withProfile).not.toBe(empty);
      expect(withBinding).not.toBe(withProfile);
    });
  });

  describe("schema exports", () => {
    it("CapabilityProfileIdSchema accepts a valid lowercase slug", () => {
      expect(CapabilityProfileIdSchema.parse("researchers")).toBe("researchers");
    });

    it("CapabilityProfileIdSchema rejects uppercase / spaces", () => {
      expect(() => CapabilityProfileIdSchema.parse("Bad Id")).toThrow();
    });

    it("AgentIdSchema accepts a valid slug", () => {
      expect(AgentIdSchema.parse("agent-1")).toBe("agent-1");
    });

    it("AgentIdSchema rejects an invalid shape", () => {
      expect(() => AgentIdSchema.parse("BAD")).toThrow();
    });

    it("rejects an invalid mcpServer id via McpServerIdSchema (uppercase / space)", () => {
      expect(() =>
        CapabilityProfileSchema.parse({
          profileId: "p",
          label: "P",
          skills: [],
          mcpServers: ["BAD ID"],
          extensions: [],
          notes: ""
        })
      ).toThrow();
    });
  });
});
