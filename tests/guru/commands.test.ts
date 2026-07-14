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

describe("YOLO access presentation", () => {
  it("shows routine mutations as YOLO rather than per-call gated", () => {
    expect(getToolAccessMode("read", true)).toBe("free");
    expect(getToolAccessMode("write", true)).toBe("yolo");
    expect(getToolAccessMode("write", false)).toBe("approval");
  });

  it("uses the spawn-time YOLO snapshot when present", () => {
    expect(resolveWorkerYolo({ yolo: true }, false)).toBe(true);
    expect(resolveWorkerYolo({ yolo: false }, true)).toBe(false);
    expect(resolveWorkerYolo(undefined, true)).toBe(true);
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
