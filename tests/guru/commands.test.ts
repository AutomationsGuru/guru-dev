import { Readable } from "node:stream";

import {
  approvalChoiceFromAnswer,
  completeSlashCommand,
  createIdleInterruptGuard,
  evaluateSlashGuess,
  filterSlashCommands,
  formatMcpStatusLines,
  formatApprovalOutcome,
  getToolAccessMode,
  isDirectGuruInvocation,
  injectRepoRoot,
  parseSlashCommand,
  readApprovalAnswer,
  resolveWorkerYolo,
  resolveRouteSelector,
  sortedRoutes,
  SLASH_COMMANDS,
  withRuntimeCleanup
} from "../../src/guru.js";
import { createDirectProviderCatalog } from "../../src/providers/catalog.js";
import { isMemorySlashCommand } from "../../src/guru/memorySessionService.js";

type EffectiveAccessDescription = {
  readonly mode: "yolo" | "safe" | "policy";
  readonly chip: string;
  readonly summary: string;
  readonly grantCount: number;
  readonly grantsShadowed: boolean;
};

type DescribeEffectiveAccess = (input: {
  readonly yolo: boolean;
  readonly mandate: {
    readonly grants: readonly {
      readonly scope: "space" | "machine";
      readonly path?: string;
      readonly verbs: readonly string[];
      readonly grantedAt: string;
    }[];
    readonly denies: readonly unknown[];
  };
  readonly sessionApprovals?: ReadonlySet<string>;
}) => EffectiveAccessDescription;

type FormatMandateOverview = (input: Parameters<DescribeEffectiveAccess>[0] & { readonly filePath: string }) => readonly string[];

type BuildAccessDrillMenuItems = (
  parentId: "/status" | "/yolo" | "/mandate",
  input: Parameters<DescribeEffectiveAccess>[0]
) => readonly { readonly id: string; readonly label: string; readonly hint?: string }[];

describe("guru entrypoint detection", () => {
  const moduleEntry = "/repo/dist/guru.js";

  it.each([
    "/repo/dist/guru.js",
    "/repo/dist/guru.ts",
    "/repo/node_modules/.bin/guru",
    "C:\\Users\\agentos\\AppData\\Roaming\\npm\\guru.cmd",
    "C:\\Users\\agentos\\AppData\\Roaming\\npm\\guru.ps1"
  ])("starts for a direct or npm launcher entrypoint: %s", (argvEntry) => {
    expect(isDirectGuruInvocation(argvEntry, moduleEntry)).toBe(true);
  });

  it.each(["/repo/node_modules/.bin/vitest", "/repo/dist/cli.js", undefined])(
    "does not start for an importing process: %s",
    (argvEntry) => {
      expect(isDirectGuruInvocation(argvEntry, moduleEntry)).toBe(false);
    }
  );

  it("requires the guru module itself, not only a matching argv basename", () => {
    expect(isDirectGuruInvocation("/repo/node_modules/.bin/guru", "/repo/dist/cli.js")).toBe(false);
  });
});

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

describe("memory command adapter", () => {
  it("routes exactly the three memory commands through the shared service", () => {
    expect(["/remember", "/memory", "/recall"].filter(isMemorySlashCommand)).toEqual(["/remember", "/memory", "/recall"]);
    expect(["/memo", "/settings", "remember"].filter(isMemorySlashCommand)).toEqual([]);
  });
});

describe("YOLO access presentation", () => {
  it("shows routine mutations as YOLO rather than per-call gated", () => {
    expect(getToolAccessMode("read", true)).toBe("free");
    expect(getToolAccessMode("write", true)).toBe("yolo");
    expect(getToolAccessMode("write", false)).toBe("approval");
  });

  it("labels mutation tools as policy-controlled when saved grants are effective", () => {
    const resolveMode = getToolAccessMode as unknown as (
      toolId: string,
      yolo: boolean,
      mandate: Parameters<DescribeEffectiveAccess>[0]["mandate"],
      sessionApprovals?: ReadonlySet<string>,
      cwd?: string
    ) => string;
    expect(resolveMode("write", false, {
      grants: [{ scope: "machine", verbs: ["read", "write", "exec"], grantedAt: "2026-07-14T16:01:58.903Z" }],
      denies: []
    })).toBe("policy");
    expect(resolveMode("write", false, {
      grants: [{ scope: "machine", verbs: ["read"], grantedAt: "2026-07-14T16:01:58.903Z" }],
      denies: []
    })).toBe("approval");
    expect(resolveMode("write", false, { grants: [], denies: [] }, new Set(["write"]))).toBe("session");
  });

  describe("path-aware /tools access rows", () => {
    const activeRepo = process.platform === "win32" ? "C:\\work\\project" : "/work/project";
    const activeSpace = process.platform === "win32" ? "C:\\work" : "/work";
    const otherRepo = process.platform === "win32" ? "C:\\other" : "/other";
    const resolveMode = getToolAccessMode as unknown as (
      toolId: string,
      yolo: boolean,
      mandate: Parameters<DescribeEffectiveAccess>[0]["mandate"],
      sessionApprovals: ReadonlySet<string> | undefined,
      cwd: string
    ) => string;

    it("renders ASK for a SPACE write grant outside the active repo", () => {
      expect(resolveMode("write", false, {
        grants: [{ scope: "space", path: otherRepo, verbs: ["write"], grantedAt: "t" }],
        denies: []
      }, undefined, activeRepo)).toBe("approval");
    });

    it("renders POLICY for a SPACE write grant covering the active repo", () => {
      expect(resolveMode("write", false, {
        grants: [{ scope: "space", path: activeSpace, verbs: ["write"], grantedAt: "t" }],
        denies: []
      }, undefined, activeRepo)).toBe("policy");
    });

    it("renders DENY when a scoped write deny covers the active repo under YOLO", () => {
      expect(resolveMode("write", true, {
        grants: [],
        denies: [{ verb: "write", path: activeSpace }]
      }, undefined, activeRepo)).toBe("denied");
    });

    it("renders DENY when a scoped write deny covers the active repo despite session approval", () => {
      expect(resolveMode("write", false, {
        grants: [],
        denies: [{ verb: "write", path: activeSpace }]
      }, new Set(["write"]), activeRepo)).toBe("denied");
    });

    it("does not treat a non-covering scoped deny as a global DENY", () => {
      expect(resolveMode("write", true, {
        grants: [],
        denies: [{ verb: "write", path: otherRepo }]
      }, undefined, activeRepo)).toBe("yolo");
    });
  });

  it("uses the spawn-time YOLO snapshot when present", () => {
    expect(resolveWorkerYolo({ yolo: true }, false)).toBe(true);
    expect(resolveWorkerYolo({ yolo: false }, true)).toBe(false);
    expect(resolveWorkerYolo(undefined, true)).toBe(true);
  });

  it("derives one truthful effective mode for YOLO, safe, and saved-policy states", async () => {
    const module = (await import("../../src/guru.js")) as unknown as {
      readonly describeEffectiveAccess?: DescribeEffectiveAccess;
    };
    expect(module.describeEffectiveAccess, "shared effective-access descriptor must be exported").toBeTypeOf("function");
    if (!module.describeEffectiveAccess) return;

    const grant = {
      scope: "machine" as const,
      verbs: ["read", "write", "exec"],
      grantedAt: "2026-07-14T16:01:58.903Z"
    };
    const empty = { grants: [], denies: [] } as const;
    const saved = { grants: [grant], denies: [] } as const;

    const yolo = module.describeEffectiveAccess({ yolo: true, mandate: saved });
    expect(yolo).toMatchObject({ mode: "yolo", chip: "⚡YOLO", grantCount: 1, grantsShadowed: true });
    expect(yolo.summary).toMatch(/ordinary machine read\/write\/exec.*direct/iu);
    expect(yolo.summary).toMatch(/saved grant.*shadowed/iu);

    const safe = module.describeEffectiveAccess({ yolo: false, mandate: empty });
    expect(safe).toMatchObject({ mode: "safe", chip: "SAFE", grantCount: 0, grantsShadowed: false });
    expect(safe.summary).toMatch(/no saved grants.*per-call approval/iu);

    const policy = module.describeEffectiveAccess({ yolo: false, mandate: saved });
    expect(policy).toMatchObject({ mode: "policy", chip: "POLICY:1", grantCount: 1, grantsShadowed: false });
    expect(policy.summary).toMatch(/machine read\+write\+exec.*direct/iu);
    expect(policy.summary).toMatch(/uncovered.*per-call approval/iu);

    for (const description of [yolo, safe, policy]) {
      expect(description.summary).toMatch(/denies.*destructive.*spend.*secret.*auth.*bind/iu);
    }
  });

  it("never describes denied or hard-edge persisted verbs as direct", async () => {
    const module = (await import("../../src/guru.js")) as unknown as {
      readonly describeEffectiveAccess?: DescribeEffectiveAccess;
    };
    expect(module.describeEffectiveAccess).toBeTypeOf("function");
    if (!module.describeEffectiveAccess) return;

    const hardEdges = module.describeEffectiveAccess({
      yolo: false,
      mandate: {
        grants: [{ scope: "machine", verbs: ["destructive", "spend"], grantedAt: "2026-07-14T16:01:58.903Z" }],
        denies: []
      }
    });
    expect(hardEdges.summary).not.toMatch(/(?:destructive|spend).*remain direct/iu);
    expect(hardEdges.summary).toMatch(/no direct ordinary verbs/iu);
    expect(hardEdges.summary).toMatch(/destructive.*spend.*bind/iu);

    const denyWins = module.describeEffectiveAccess({
      yolo: false,
      mandate: {
        grants: [{ scope: "machine", verbs: ["read", "write"], grantedAt: "2026-07-14T16:01:58.903Z" }],
        denies: [{ verb: "write" }]
      }
    });
    expect(denyWins.summary).toMatch(/machine read.*direct/iu);
    expect(denyWins.summary).not.toMatch(/read\+write.*direct/iu);

    const scopedDeny = module.describeEffectiveAccess({
      yolo: false,
      mandate: {
        grants: [{ scope: "machine", verbs: ["read"], grantedAt: "2026-07-14T16:01:58.903Z" }],
        denies: [{ verb: "read", path: "/restricted" }]
      }
    });
    expect(scopedDeny.summary).toMatch(/machine read.*direct where no scoped deny applies/iu);

    const deniedSessionApproval = module.describeEffectiveAccess({
      yolo: false,
      mandate: { grants: [], denies: [{ verb: "write" }] },
      sessionApprovals: new Set(["write"])
    });
    expect(deniedSessionApproval.summary).not.toMatch(/session-approved write.*direct/iu);
  });

  it("renders a state-aware banner after /clear instead of re-announcing YOLO", async () => {
    const module = (await import("../../src/guru.js")) as unknown as {
      readonly banner?: (input?: Parameters<DescribeEffectiveAccess>[0]) => string;
    };
    expect(module.banner, "the clearable banner must accept live access state").toBeTypeOf("function");
    if (!module.banner) return;

    const output = module.banner({ yolo: false, mandate: { grants: [], denies: [] } });
    expect(output).toContain("SAFE");
    expect(output).toMatch(/per-call approval/iu);
    expect(output).not.toMatch(/YOLO.*default|never pauses/iu);
  });

  it("always explains persisted mandates, timestamps, shadowing, storage, and examples", async () => {
    const module = (await import("../../src/guru.js")) as unknown as {
      readonly formatMandateOverview?: FormatMandateOverview;
    };
    expect(module.formatMandateOverview, "bare /mandate formatter must be exported").toBeTypeOf("function");
    if (!module.formatMandateOverview) return;

    const lines = module.formatMandateOverview({
      yolo: true,
      mandate: {
        grants: [{ scope: "space", path: "/work/project", verbs: ["read", "write", "exec"], grantedAt: "2026-07-14T16:01:58.903Z" }],
        denies: []
      },
      filePath: "/home/test/.guruharness/mandates.json"
    });
    const output = lines.join("\n");

    expect(output).toMatch(/persistent.*advanced policy.*safe mode/iu);
    expect(output).toContain("/home/test/.guruharness/mandates.json");
    expect(output).toContain("space /work/project");
    expect(output).toContain("read+write+exec");
    expect(output).toContain("2026-07-14T16:01:58.903Z");
    expect(output).toMatch(/shadowed by YOLO/iu);
    expect(output).toContain("/mandate grant space work");
    expect(output).toContain("/mandate grant machine work");
    expect(output).toContain("/mandate revoke");
  });

  describe("bare /mandate deny truth", () => {
    it("enumerates deny-only policy and says matching denies remain binding under YOLO", async () => {
      const module = (await import("../../src/guru.js")) as unknown as {
        readonly formatMandateOverview?: FormatMandateOverview;
      };
      expect(module.formatMandateOverview).toBeTypeOf("function");
      if (!module.formatMandateOverview) return;

      const output = module.formatMandateOverview({
        yolo: true,
        mandate: {
          grants: [],
          denies: [{ verb: "write", path: "/work/project", note: "protect generated data" }]
        },
        filePath: "/home/test/.guruharness/mandates.json"
      }).join("\n");

      expect(output).toContain("Saved denies:");
      expect(output).toMatch(/write.*\/work\/project.*protect generated data/iu);
      expect(output).toMatch(/YOLO.*shadows.*grants only/iu);
      expect(output).toMatch(/matching denies.*remain binding/iu);
      expect(output).toMatch(/\/mandate revoke.*(?:clear|remove).*saved grants and denies/iu);
    });

    it("distinguishes saved grants from saved denies in a mixed policy", async () => {
      const module = (await import("../../src/guru.js")) as unknown as {
        readonly formatMandateOverview?: FormatMandateOverview;
      };
      expect(module.formatMandateOverview).toBeTypeOf("function");
      if (!module.formatMandateOverview) return;

      const output = module.formatMandateOverview({
        yolo: false,
        mandate: {
          grants: [{
            scope: "space",
            path: "/work/project",
            verbs: ["read", "write"],
            grantedAt: "2026-07-14T18:20:00.000Z"
          }],
          denies: [{ verb: "write", path: "/work/project/secrets", note: "keep secrets manual" }]
        },
        filePath: "/home/test/.guruharness/mandates.json"
      }).join("\n");

      expect(output).toMatch(/Saved grants:[\s\S]*space \/work\/project read\+write/iu);
      expect(output).toMatch(/Saved denies:[\s\S]*write.*\/work\/project\/secrets.*keep secrets manual/iu);
    });

    it("offers a deny-only revoke action that truthfully clears grants and denies", async () => {
      const module = (await import("../../src/guru.js")) as unknown as {
        readonly buildAccessDrillMenuItems?: BuildAccessDrillMenuItems;
      };
      expect(module.buildAccessDrillMenuItems).toBeTypeOf("function");
      if (!module.buildAccessDrillMenuItems) return;

      const items = module.buildAccessDrillMenuItems("/mandate", {
        yolo: true,
        mandate: {
          grants: [],
          denies: [{ verb: "write", path: "/work/project", note: "protect generated data" }]
        }
      });
      const revoke = items.find((item) => item.id === "/mandate revoke");

      expect(revoke).toBeDefined();
      expect(`${revoke?.label ?? ""} ${revoke?.hint ?? ""}`).toMatch(
        /(?:clear|remove|revoke).*saved grants and denies/iu
      );
    });
  });

  it("uses the shared effective-access summary in executable slash drilldowns", async () => {
    const module = (await import("../../src/guru.js")) as unknown as {
      readonly describeEffectiveAccess?: DescribeEffectiveAccess;
      readonly buildAccessDrillMenuItems?: BuildAccessDrillMenuItems;
    };
    expect(module.describeEffectiveAccess).toBeTypeOf("function");
    expect(module.buildAccessDrillMenuItems).toBeTypeOf("function");
    if (!module.describeEffectiveAccess || !module.buildAccessDrillMenuItems) return;

    const input = {
      yolo: true,
      mandate: {
        grants: [{ scope: "machine" as const, verbs: ["read", "write", "exec"], grantedAt: "2026-07-14T16:01:58.903Z" }],
        denies: []
      }
    };
    const summary = module.describeEffectiveAccess(input).summary;

    for (const parent of ["/status", "/yolo", "/mandate"] as const) {
      const items = module.buildAccessDrillMenuItems(parent, input);
      expect(items[0]?.hint).toBe(summary);
      expect(items.every((item) => item.id.startsWith("/"))).toBe(true);
    }

    const yoloItems = module.buildAccessDrillMenuItems("/mandate", input);
    const revokedYoloSummary = module.describeEffectiveAccess({ yolo: true, mandate: { grants: [], denies: [] } }).summary;
    expect(yoloItems.find((item) => item.id === "/mandate revoke")?.hint).toBe(revokedYoloSummary);

    const noGrantItems = module.buildAccessDrillMenuItems("/yolo", {
      yolo: true,
      mandate: { grants: [], denies: [] }
    });
    expect(noGrantItems.find((item) => item.id === "/yolo off")?.hint).toMatch(/per-call approval/iu);
    expect(noGrantItems.find((item) => item.id === "/yolo off")?.hint).not.toMatch(/saved policy/iu);

    const hardEdgeGrant = {
      yolo: true,
      mandate: {
        grants: [{ scope: "machine" as const, verbs: ["destructive"], grantedAt: "2026-07-14T16:01:58.903Z" }],
        denies: []
      }
    };
    const hardEdgeOff = module.buildAccessDrillMenuItems("/yolo", hardEdgeGrant);
    expect(hardEdgeOff.find((item) => item.id === "/yolo off")?.hint).toMatch(/no direct ordinary verbs/iu);

    const yoloOn = module.buildAccessDrillMenuItems("/yolo", { ...input, yolo: false });
    expect(yoloOn.find((item) => item.id === "/yolo on")?.hint).toMatch(/saved grant.*shadowed/iu);

    const revokeWithSessionApproval = module.buildAccessDrillMenuItems("/mandate", {
      yolo: false,
      mandate: {
        grants: input.mandate.grants,
        denies: [{ verb: "exec" }]
      },
      sessionApprovals: new Set(["exec"])
    });
    expect(revokeWithSessionApproval.find((item) => item.id === "/mandate revoke")?.hint).toMatch(/session-approved exec.*direct/iu);
  });
});

describe("idle Ctrl+C exit guard", () => {
  it("exits only on a second consecutive interrupt inside the quit window", () => {
    let now = 1_000;
    const guard = createIdleInterruptGuard({ windowMs: 1_500, now: () => now });

    expect(guard.interrupt()).toBe("arm");
    now += 500;
    expect(guard.interrupt()).toBe("exit");
  });

  it("normal input disarms a pending exit", () => {
    const guard = createIdleInterruptGuard();

    expect(guard.interrupt()).toBe("arm");
    guard.activity();
    expect(guard.interrupt()).toBe("arm");
  });

  it("an expired quit window requires a fresh first interrupt", () => {
    let now = 1_000;
    const guard = createIdleInterruptGuard({ windowMs: 1_500, now: () => now });

    expect(guard.interrupt()).toBe("arm");
    now += 1_501;
    expect(guard.interrupt()).toBe("arm");
  });
});

describe("runtime cleanup", () => {
  it("closes runtime resources after a normal interactive run", async () => {
    const close = vi.fn(async () => {});

    await expect(withRuntimeCleanup(async () => "done", close)).resolves.toBe("done");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes runtime resources when the interactive run throws", async () => {
    const close = vi.fn(async () => {});
    const failure = new Error("composer failed");

    await expect(withRuntimeCleanup(async () => Promise.reject(failure), close)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("MCP status visibility", () => {
  it("formats missing and broken configured servers for the /tools surface", () => {
    const lines = formatMcpStatusLines([
      {
        serverId: "docs",
        status: "missing-env",
        transport: "stdio",
        missingEnvNames: ["DOCS_TOKEN"],
        summary: "Missing required environment variable."
      },
      {
        serverId: "broken",
        status: "error",
        transport: "stdio",
        missingEnvNames: [],
        summary: "Discovery failed."
      }
    ]);

    expect(lines).toEqual([
      "docs · missing-env · Missing required environment variable. · missing: DOCS_TOKEN",
      "broken · error · Discovery failed."
    ]);
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

  it("resolves an UNAMBIGUOUS providerId prefix; an ambiguous one returns undefined (review 2026-07-08)", () => {
    // A providerId with exactly one route resolves directly.
    const single = routes.filter((r) => r.providerId === "sakana");
    const singleRoutes = single.length === 1 ? routes : routes;
    // `openai-codex` has multiple routes in the full catalog → ambiguous → undefined
    // (old behavior silently picked whichever sorted first; now the operator is
    // told to be specific).
    const codexMatches = routes.filter((r) => r.providerId === "openai-codex" || r.routeId.startsWith("openai-codex/"));
    if (codexMatches.length > 1) {
      expect(resolveRouteSelector(routes, "openai-codex")).toBeUndefined();
    }
    // A synthetic single-route provider resolves.
    expect(resolveRouteSelector([{ ...routes[0]!, providerId: "solo-prov", routeId: "solo-prov/only-model" }], "solo-prov")?.routeId).toBe("solo-prov/only-model");
  });

  it("returns undefined for unknown selectors", () => {
    expect(resolveRouteSelector(routes, "nope/never")).toBeUndefined();
    expect(resolveRouteSelector(routes, "999")).toBeUndefined();
  });

  it("rejects non-canonical numeric input (no silent truncation of '1.5' → 1)", () => {
    // `Number.parseInt("1.5", 10)` returns 1; before the strict guard, /model 1.5
    // would silently connect to the first route. The strict guard rejects any
    // input that isn't a clean positive integer and falls through to the
    // providerId prefix lookup — which for "1.5" finds no route, returning
    // undefined instead of misrouting to the wrong model.
    expect(resolveRouteSelector(routes, "1.5")).toBeUndefined();
    expect(resolveRouteSelector(routes, "01")).toBeUndefined();
    expect(resolveRouteSelector(routes, "0")).toBeUndefined();
    expect(resolveRouteSelector(routes, "-1")).toBeUndefined();
    expect(resolveRouteSelector(routes, "1e3")).toBeUndefined();
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

  it("describes status, YOLO, and mandates as one effective-access surface", () => {
    for (const name of ["/status", "/yolo", "/mandate"] as const) {
      expect(SLASH_COMMANDS.find((command) => command.name === name)?.description).toMatch(/effective access/iu);
    }
  });

  it("describes /mandate as inclusive persistent policy", () => {
    const description = SLASH_COMMANDS.find((command) => command.name === "/mandate")?.description ?? "";
    expect(description).toMatch(/persistent.*(?:policy|grants?.*denies?)/iu);
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

describe("evaluateSlashGuess — Enter-on-slash policy", () => {
  // Exact match: runs as-is, no "→ /x" hint.
  it("exact /model is 'exact', no hint", () => {
    expect(evaluateSlashGuess({ command: "/model", args: [] })).toEqual({
      kind: "exact",
      command: "/model"
    });
  });

  // Confident prefix: auto-runs with a "→ /x" hint.
  it("/mo → auto-run /model", () => {
    expect(evaluateSlashGuess({ command: "/mo", args: [] })).toEqual({
      kind: "auto-run",
      command: "/model"
    });
  });

  it("/memo → auto-run /memory", () => {
    expect(evaluateSlashGuess({ command: "/memo", args: [] })).toEqual({
      kind: "auto-run",
      command: "/memory"
    });
  });

  // Side-effect commands require the full name — the original /exit hardening,
  // extended in this pass.
  it("/exi → blocked: must type /exit in full", () => {
    expect(evaluateSlashGuess({ command: "/exi", args: [] })).toEqual({
      kind: "blocked",
      command: "/exit",
      reason: "no-guess-run"
    });
  });

  it("/logi → blocked: must type /login in full (no surprise OAuth fires)", () => {
    expect(evaluateSlashGuess({ command: "/logi", args: [] })).toEqual({
      kind: "blocked",
      command: "/login",
      reason: "no-guess-run"
    });
  });

  it("/log → blocked (first match in registration order, both are in blocklist)", () => {
    // Both /login and /logout are in the blocklist; the matcher picks the first
    // by stable sort order of SLASH_COMMANDS (login precedes logout). The verdict
    // kind is what matters: blocked. Either target command is a valid outcome.
    const verdict = evaluateSlashGuess({ command: "/log", args: [] });
    expect(verdict.kind).toBe("blocked");
    expect(verdict).toMatchObject({ kind: "blocked", reason: "no-guess-run" });
    if (verdict.kind === "blocked") {
      expect(["/login", "/logout"]).toContain(verdict.command);
    }
  });

  it("/compact (side-effect: durable history rewrite) → blocked", () => {
    expect(evaluateSlashGuess({ command: "/com", args: [] })).toEqual({
      kind: "blocked",
      command: "/compact",
      reason: "no-guess-run"
    });
  });

  it("/rewind (side-effect: session fork) → blocked on /rew prefix", () => {
    expect(evaluateSlashGuess({ command: "/rew", args: [] })).toEqual({
      kind: "blocked",
      command: "/rewind",
      reason: "no-guess-run"
    });
  });

  it("/yolo → blocked: must type /yolo in full", () => {
    expect(evaluateSlashGuess({ command: "/yol", args: [] })).toEqual({
      kind: "blocked",
      command: "/yolo",
      reason: "no-guess-run"
    });
  });

  // Exact-name on a blocked command still runs (operator typed it in full).
  it("/logout (full name) is 'exact', runs without hint", () => {
    expect(evaluateSlashGuess({ command: "/logout", args: ["anthropic"] })).toEqual({
      kind: "exact",
      command: "/logout"
    });
  });

  // Substring / description-keyword matches surface a weak-match warning instead
  // of auto-running (defensive — most partials that hit a non-blocklisted command
  // via substring also happen to be prefix matches, so this verdict is rare).
  it("substring-only matches surface a weak-match warning instead of auto-running", () => {
    // The fuzzy matcher's substring tier matches when the partial appears inside
    // a command name WITHOUT being a prefix of any name. /elp is a substring of
    // /help (the only command containing "elp" in its name), and /elp is NOT
    // a prefix of any other command. /help is NOT in the blocklist → weak-match.
    expect(evaluateSlashGuess({ command: "/elp", args: [] })).toEqual({
      kind: "weak-match",
      command: "/help",
      reason: "substring-or-description"
    });
  });

  it("unknown commands resolve to 'no-match'", () => {
    expect(evaluateSlashGuess({ command: "/banana", args: [] })).toEqual({
      kind: "no-match"
    });
  });
});

describe("readApprovalAnswer — single-key approval prompt input", () => {
  // Mock stream that pushes input via .push() — node's stream.Readable supports
  // read() mode; we mimic a TTY's data events by emitting Buffer chunks.
  const makeStream = (): Readable => {
    const r = new Readable({ read() {} });
    return r;
  };

  it("resolves 'y' on a single printable byte", async () => {
    const stream = makeStream();
    const promise = readApprovalAnswer(stream);
    queueMicrotask(() => stream.push(Buffer.from("y")));
    await expect(promise).resolves.toBe("y");
  });

  it("resolves 'n' on a single printable byte (fail-safe default)", async () => {
    const stream = makeStream();
    const promise = readApprovalAnswer(stream);
    queueMicrotask(() => stream.push(Buffer.from("n")));
    await expect(promise).resolves.toBe("n");
  });

  it("does NOT resolve on backspace (\"fixing a typo\" no longer denies the prompt)", async () => {
    const stream = makeStream();
    const promise = readApprovalAnswer(stream);
    queueMicrotask(() => stream.push(Buffer.from("\x7f")));
    // Backspace should be ignored. Push 'y' after to confirm the prompt stays open.
    queueMicrotask(() => stream.push(Buffer.from("y")));
    await expect(promise).resolves.toBe("y");
  });

  it("does NOT resolve on an arrow-key CSI (arrow up) — only a lone Esc denies", async () => {
    const stream = makeStream();
    const promise = readApprovalAnswer(stream);
    queueMicrotask(() => stream.push(Buffer.from("\x1b[A"))); // arrow up
    queueMicrotask(() => stream.push(Buffer.from("y")));
    await expect(promise).resolves.toBe("y");
  });

  it("Enter denies (matches the on-screen [n/enter/esc] hint)", async () => {
    const stream = makeStream();
    const promise = readApprovalAnswer(stream);
    queueMicrotask(() => stream.push(Buffer.from("\r")));
    await expect(promise).resolves.toBe("n");
  });

  it("lone Esc denies (fail-safe)", async () => {
    const stream = makeStream();
    const promise = readApprovalAnswer(stream);
    // Grace timer (~30ms) for lone ESC in the key decoder.
    setTimeout(() => stream.push(Buffer.from("\x1b")), 0);
    await expect(promise).resolves.toBe("n");
  }, 5_000);

  it("maps answers to once/always/deny (hard edge cannot always)", () => {
    expect(approvalChoiceFromAnswer("y", true)).toBe("once");
    expect(approvalChoiceFromAnswer("a", true)).toBe("always");
    expect(approvalChoiceFromAnswer("a", false)).toBe("deny");
    expect(approvalChoiceFromAnswer("n", true)).toBe("deny");
    expect(formatApprovalOutcome("once", "write")).toMatch(/allowed once.*write/u);
    expect(formatApprovalOutcome("deny", "bash")).toMatch(/denied.*bash/u);
  });

  it("Ctrl+C during an approval prompt resolves as deny (fail-safe)", async () => {
    const stream = makeStream();
    const promise = readApprovalAnswer(stream);
    queueMicrotask(() => stream.push(Buffer.from("\x03")));
    await expect(promise).resolves.toBe("n");
  });

  it("lowercase and uppercase both resolve correctly", async () => {
    for (const byte of ["y", "Y", "a", "A", "n", "N"]) {
      const stream = makeStream();
      const promise = readApprovalAnswer(stream);
      queueMicrotask(() => stream.push(Buffer.from(byte)));
      await expect(promise, `byte "${byte}"`).resolves.toBe(byte.toLowerCase());
    }
  });

  it("ignores characters outside y/a/n (e.g. typing 'x' or 'q' keeps prompt open)", async () => {
    const stream = makeStream();
    const promise = readApprovalAnswer(stream);
    queueMicrotask(() => stream.push(Buffer.from("x")));
    queueMicrotask(() => stream.push(Buffer.from("q")));
    queueMicrotask(() => stream.push(Buffer.from("y")));
    await expect(promise).resolves.toBe("y");
  });
});
