import {
  ContextRegistry,
  hardCap
} from "../../src/context/providers/registry.js";
import {
  captureGitDiffSnapshot,
  createGitDiffProvider,
  sliceDiffToBudget
} from "../../src/context/providers/gitDiffProvider.js";
import type { ContextBudget, ContextProvider, ContextSnippet } from "../../src/context/providers/types.js";
import type { CommandExecutor } from "../../src/review/gates.js";

/** Build a fake executor that returns the given stdout for any git-diff call. */
function fakeDiffExecutor(diff: string, exitCode = 0): CommandExecutor {
  return async () => ({
    exitCode,
    stdout: diff,
    stderr: "",
    durationMs: 1
  });
}

/** Build a fake executor that records each invocation's command. */
function recordingExecutor(stdout: string): { executor: CommandExecutor; calls: string[][] } {
  const calls: string[][] = [];
  const executor: CommandExecutor = async (command) => {
    calls.push([...command]);
    return { exitCode: 0, stdout, stderr: "", durationMs: 1 };
  };
  return { executor, calls };
}

/** A trivial provider that returns one snippet of `body` characters. */
function fixedProvider(id: string, body: string): ContextProvider {
  return {
    id,
    label: id,
    collect(): ContextSnippet[] {
      return [{ id: `${id}:0`, label: id, body }];
    }
  };
}

describe("sliceDiffToBudget", () => {
  it("returns the body unchanged when it fits", () => {
    expect(sliceDiffToBudget("abc", { maxChars: 10 })).toBe("abc");
  });

  it("truncates and appends a marker when the body exceeds the cap", () => {
    const budget: ContextBudget = { maxChars: 80 };
    const out = sliceDiffToBudget("abcdefghijklmnopqrstuvwxyz".repeat(10), budget);
    expect(out.length).toBeLessThanOrEqual(budget.maxChars);
    expect(out.endsWith("…<diff truncated to fit context budget>")).toBe(true);
  });

  it("never exceeds the cap even when the marker alone is longer than the budget", () => {
    const budget: ContextBudget = { maxChars: 5 };
    const out = sliceDiffToBudget("abcdefghijklmnopqrstuvwxyz", budget);
    expect(out.length).toBeLessThanOrEqual(budget.maxChars);
  });
});

describe("captureGitDiffSnapshot", () => {
  it("reports git unavailable and empty diff when no executor is injected", async () => {
    const snapshot = await captureGitDiffSnapshot({ repoRoot: "/tmp/repo" });
    expect(snapshot).toEqual({ gitAvailable: false, diff: "" });
  });

  it("reports unavailable when git exits non-zero (not a repo / no git)", async () => {
    const snapshot = await captureGitDiffSnapshot({
      repoRoot: "/tmp/repo",
      executor: fakeDiffExecutor("", 128)
    });
    expect(snapshot.gitAvailable).toBe(false);
    expect(snapshot.diff).toBe("");
  });

  it("captures stdout when git succeeds", async () => {
    const snapshot = await captureGitDiffSnapshot({
      repoRoot: "/tmp/repo",
      executor: fakeDiffExecutor("diff --git a/x b/x\n")
    });
    expect(snapshot.gitAvailable).toBe(true);
    expect(snapshot.diff).toContain("diff --git");
  });
});

describe("createGitDiffProvider", () => {
  it("returns no snippets for an empty / whitespace-only diff (clean tree)", async () => {
    const provider = createGitDiffProvider({
      repoRoot: "/tmp/repo",
      executor: fakeDiffExecutor("   \n  ")
    });
    const snippets = await provider.collect({ maxChars: 1000 });
    expect(snippets).toEqual([]);
  });

  it("returns no snippets when git is unavailable (no executor)", async () => {
    const provider = createGitDiffProvider({ repoRoot: "/tmp/repo" });
    const snippets = await provider.collect({ maxChars: 1000 });
    expect(snippets).toEqual([]);
  });

  it("returns no snippets when the budget is zero", async () => {
    const provider = createGitDiffProvider({
      repoRoot: "/tmp/repo",
      executor: fakeDiffExecutor("diff body")
    });
    const snippets = await provider.collect({ maxChars: 0 });
    expect(snippets).toEqual([]);
  });

  it("surfaces a single snippet bounded by the budget", async () => {
    const provider = createGitDiffProvider({
      repoRoot: "/tmp/repo",
      executor: fakeDiffExecutor("0123456789".repeat(10))
    });
    const snippets = await provider.collect({ maxChars: 25 });
    expect(snippets).toHaveLength(1);
    expect(snippets[0]!.body.length).toBeLessThanOrEqual(25);
    expect(snippets[0]!.id).toBe("git-diff:head");
  });
});

describe("hardCap", () => {
  it("returns an empty list for a non-positive cap", () => {
    const snippets: ContextSnippet[] = [{ id: "a", label: "a", body: "x" }];
    expect(hardCap(snippets, 0)).toEqual([]);
    expect(hardCap(snippets, -1)).toEqual([]);
  });

  it("drops tail snippets once the cap is reached", () => {
    const snippets: ContextSnippet[] = [
      { id: "a", label: "a", body: "aaaa" },
      { id: "b", label: "b", body: "bbbb" },
      { id: "c", label: "c", body: "cccc" }
    ];
    expect(hardCap(snippets, 8).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("truncates the final snippet when it alone crosses the cap", () => {
    const snippets: ContextSnippet[] = [
      { id: "a", label: "a", body: "aaaa" },
      { id: "b", label: "b", body: "bbbbbbbb" }
    ];
    const out = hardCap(snippets, 6);
    expect(out).toHaveLength(2);
    expect(out[1]!.body).toBe("bb");
    expect(out.reduce((n, s) => n + s.body.length, 0)).toBe(6);
  });
});

describe("ContextRegistry", () => {
  it("lists providers in insertion order", () => {
    const registry = new ContextRegistry()
      .register(fixedProvider("alpha", "a"))
      .register(fixedProvider("beta", "b"));
    expect(registry.list().map((p) => p.id)).toEqual(["alpha", "beta"]);
  });

  it("unregister removes a provider", () => {
    const registry = new ContextRegistry().register(fixedProvider("alpha", "a"));
    expect(registry.unregister("alpha")).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(registry.unregister("missing")).toBe(false);
  });

  it("is enabled by default; disable is per-project", () => {
    const registry = new ContextRegistry().register(fixedProvider("alpha", "a"));
    expect(registry.isEnabled("alpha")).toBe(true);
    expect(registry.isEnabled("alpha", "proj-x")).toBe(true);

    registry.disable("alpha", "proj-x");
    expect(registry.isEnabled("alpha", "proj-x")).toBe(false);
    // Other projects unaffected.
    expect(registry.isEnabled("alpha", "proj-y")).toBe(true);
    expect(registry.isEnabled("alpha")).toBe(true);

    registry.enable("alpha", "proj-x");
    expect(registry.isEnabled("alpha", "proj-x")).toBe(true);
  });

  it("isEnabled is false for an unregistered id", () => {
    const registry = new ContextRegistry();
    expect(registry.isEnabled("ghost")).toBe(false);
    expect(registry.isEnabled("ghost", "proj")).toBe(false);
  });

  it("runAll splits the total budget evenly across enabled providers", async () => {
    const a = fixedProvider("alpha", "0123456789"); // 10 chars
    const b = fixedProvider("beta", "0123456789"); // 10 chars
    const registry = new ContextRegistry().register(a).register(b);

    const result = await registry.runAll({ maxChars: 10 });
    expect(result.enabledCount).toBe(2);
    expect(result.perProviderBudget).toBe(5);
    // Each provider got a 5-char share.
    expect(result.snippets[0]!.body).toBe("01234");
    expect(result.snippets[1]!.body).toBe("01234");
    expect(totalBody(result.snippets)).toBeLessThanOrEqual(10);
  });

  it("runAll honors the total cap even when providers overshoot their share", async () => {
    const overshoot: ContextProvider = {
      id: "overshoot",
      label: "overshoot",
      collect(): ContextSnippet[] {
        // Ignores the budget entirely.
        return [{ id: "overshoot:0", label: "o", body: "x".repeat(1000) }];
      }
    };
    const registry = new ContextRegistry().register(overshoot);
    const result = await registry.runAll({ maxChars: 7 });
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0]!.body.length).toBe(7);
  });

  it("runAll skips disabled providers for the given project", async () => {
    const { executor, calls } = recordingExecutor("diff-body");
    const git = createGitDiffProvider({ repoRoot: "/tmp/repo", executor });
    const other = fixedProvider("other", "y");
    const registry = new ContextRegistry().register(git).register(other);

    registry.disable("git-diff", "proj-x");

    const result = await registry.runAll({ maxChars: 100 }, "proj-x");
    expect(result.enabledCount).toBe(1);
    expect(result.snippets.map((s) => s.id)).toEqual(["other:0"]);
    // The disabled git provider was never invoked.
    expect(calls).toHaveLength(0);

    // Without the project filter, git-diff runs again.
    const result2 = await registry.runAll({ maxChars: 100 });
    expect(result2.enabledCount).toBe(2);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("runAll returns nothing when the total budget is non-positive", async () => {
    const registry = new ContextRegistry().register(fixedProvider("alpha", "a"));
    const result = await registry.runAll({ maxChars: 0 });
    expect(result.snippets).toEqual([]);
    expect(result.enabledCount).toBe(1);
  });

  it("runAll returns nothing when no providers are registered", async () => {
    const registry = new ContextRegistry();
    const result = await registry.runAll({ maxChars: 100 });
    expect(result.snippets).toEqual([]);
    expect(result.enabledCount).toBe(0);
  });

  it("a provider that throws contributes nothing and does not fail the run", async () => {
    const boom: ContextProvider = {
      id: "boom",
      label: "boom",
      collect(): ContextSnippet[] {
        throw new Error("kaboom");
      }
    };
    const ok = fixedProvider("ok", "z");
    const registry = new ContextRegistry().register(boom).register(ok);
    const result = await registry.runAll({ maxChars: 10 });
    expect(result.snippets.map((s) => s.id)).toEqual(["ok:0"]);
  });

  it("snapshot reflects providers and per-project disable state", () => {
    const registry = new ContextRegistry()
      .register(fixedProvider("alpha", "a"))
      .register(fixedProvider("beta", "b"))
      .disable("beta", "proj-x");
    expect(registry.snapshot()).toEqual({
      providerIds: ["alpha", "beta"],
      disabled: { "proj-x": { beta: true } }
    });
  });
});

function totalBody(snippets: readonly ContextSnippet[]): number {
  return snippets.reduce((n, s) => n + s.body.length, 0);
}
