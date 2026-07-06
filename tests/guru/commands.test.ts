import { completeSlashCommand, filterSlashCommands, injectRepoRoot, parseSlashCommand, resolveRouteSelector, sortedRoutes, SLASH_COMMANDS } from "../../src/guru.js";
import { createDirectProviderCatalog } from "../../src/providers/catalog.js";

describe("parseSlashCommand", () => {
  it("parses slash commands with args and lowercases the command", () => {
    expect(parseSlashCommand("/Model sakana/fugu-ultra override-x")).toEqual({
      command: "/model",
      args: ["sakana/fugu-ultra", "override-x"]
    });
  });

  it("returns null for chat text", () => {
    expect(parseSlashCommand("hello there")).toBeNull();
    expect(parseSlashCommand("  what is 2+2?")).toBeNull();
  });
});

describe("resolveRouteSelector", () => {
  const routes = createDirectProviderCatalog();

  it("resolves an exact routeId", () => {
    expect(resolveRouteSelector(routes, "sakana/fugu-ultra")?.routeId).toBe("sakana/fugu-ultra");
  });

  it("resolves a 1-based numeric index in direct-first order", () => {
    const ordered = sortedRoutes(routes);
    expect(resolveRouteSelector(routes, "1")?.routeId).toBe(ordered[0]?.routeId);
    expect(resolveRouteSelector(routes, String(routes.length))?.routeId).toBe(ordered[routes.length - 1]?.routeId);
  });

  it("resolves a providerId prefix (e.g. openai-codex for plugging in codex)", () => {
    expect(resolveRouteSelector(routes, "openai-codex")?.routeId).toBe("openai-codex/gpt-5.5");
  });

  it("returns undefined for unknown selectors", () => {
    expect(resolveRouteSelector(routes, "nope/never")).toBeUndefined();
    expect(resolveRouteSelector(routes, "999")).toBeUndefined();
  });
});

describe("SLASH_COMMANDS", () => {
  it("covers the command surface", () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    for (const required of ["/help", "/status", "/model", "/models", "/sessions", "/resume", "/new", "/skills", "/settings", "/login", "/tools", "/mandate", "/clear", "/exit"]) {
      expect(names).toContain(required);
    }
    // /allow-writes was retired in v0.22 — per-call approval replaced the binary.
    expect(names).not.toContain("/allow-writes");
  });
});

describe("bare / menu", () => {
  it("parses a lone slash as the menu command", () => {
    expect(parseSlashCommand("/")).toEqual({ command: "/", args: [] });
  });
});

describe("injectRepoRoot session defaults", () => {
  const session = { repo: { repoRoot: "D:/work/proj" } } as unknown as Parameters<typeof injectRepoRoot>[2];

  it("defaults approved bash to a real run (dryRun:false) — shakedown fix", () => {
    expect(injectRepoRoot("bash", { command: ["npm", "test"] }, session)).toMatchObject({
      command: ["npm", "test"],
      dryRun: false,
      repoRoot: "D:/work/proj"
    });
  });

  it("preserves an explicit dryRun from the model", () => {
    expect(injectRepoRoot("bash", { command: ["npm", "test"], dryRun: true }, session)).toMatchObject({ dryRun: true });
  });

  it("defaults repo.context.resolve to compact contents", () => {
    expect(injectRepoRoot("repo.context.resolve", {}, session)).toMatchObject({ includeContents: false });
  });

  it("leaves non-base tools untouched", () => {
    expect(injectRepoRoot("skills.catalog.list", { a: 1 }, session)).toEqual({ a: 1 });
  });
});

describe("slash command filtering (live menu + Tab guess)", () => {
  it("ranks prefix matches first", () => {
    expect(filterSlashCommands("/re")[0]?.name).toBe("/resume");
    expect(filterSlashCommands("/mo")[0]?.name).toBe("/model");
  });

  it("matches by name substring (intent)", () => {
    expect(filterSlashCommands("/mand").some((c) => c.name === "/mandate")).toBe(true);
  });

  it("matches by description keyword (intent)", () => {
    expect(filterSlashCommands("/conversation").some((c) => c.name === "/resume" || c.name === "/sessions" || c.name === "/new")).toBe(true);
  });

  it("returns everything for a bare slash and nothing for non-slash", () => {
    expect(filterSlashCommands("/").length).toBe(SLASH_COMMANDS.length);
    expect(filterSlashCommands("hello")).toEqual([]);
  });

  it("Tab accepts exactly the top guess", () => {
    expect(completeSlashCommand("/re")[0]).toEqual(["/resume"]);
    expect(completeSlashCommand("hello")[0]).toEqual([]);
  });
});
