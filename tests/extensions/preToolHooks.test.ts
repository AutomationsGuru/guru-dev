import { join } from "path";

import { createExtensionHost } from '../../src/extensions/host.js';
import {
  LifecycleEvents,
  mergePreToolHookDecisions,
  type PreToolHookDecision
} from '../../src/extensions/events.js';
import {
  clearPreToolHooks,
  evaluatePreToolHooks,
  registerPreToolHook,
  registerShellHooks
} from '../../src/extensions/shellHooks.js';

const hookMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  execFile: vi.fn()
}));

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: hookMocks.existsSync
}));

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: hookMocks.execFile
}));

const allow: PreToolHookDecision = { kind: "allow" };
const askA: PreToolHookDecision = { kind: "ask", reason: "ask-a" };
const askB: PreToolHookDecision = { kind: "ask", reason: "ask-b" };
const denyA: PreToolHookDecision = { kind: "deny", reason: "deny-a" };
const denyB: PreToolHookDecision = { kind: "deny", reason: "deny-b" };
const rewriteA: PreToolHookDecision = { kind: "updatedInput", input: { a: 1 } };
const rewriteB: PreToolHookDecision = { kind: "updatedInput", input: { b: 2 } };

describe("mergePreToolHookDecisions precedence", () => {
  it("allows an empty decision list (no hooks means no opinion)", () => {
    expect(mergePreToolHookDecisions([])).toEqual({ kind: "allow" });
  });

  it("merges all-allow to allow", () => {
    expect(mergePreToolHookDecisions([allow, allow, allow])).toEqual({ kind: "allow" });
  });

  it("deny beats allow regardless of position", () => {
    expect(mergePreToolHookDecisions([denyA, allow])).toBe(denyA);
    expect(mergePreToolHookDecisions([allow, denyA])).toBe(denyA);
  });

  it("deny beats ask regardless of position", () => {
    expect(mergePreToolHookDecisions([denyA, askA])).toBe(denyA);
    expect(mergePreToolHookDecisions([askA, denyA])).toBe(denyA);
  });

  it("deny beats updatedInput — a rewrite can never resurrect a denied call", () => {
    expect(mergePreToolHookDecisions([denyA, rewriteA])).toBe(denyA);
    expect(mergePreToolHookDecisions([rewriteA, denyA])).toBe(denyA);
  });

  it("keeps the FIRST deny when several hooks deny", () => {
    expect(mergePreToolHookDecisions([denyA, denyB])).toBe(denyA);
    expect(mergePreToolHookDecisions([allow, denyA, askA, denyB, rewriteA])).toBe(denyA);
  });

  it("ask beats allow and updatedInput, and keeps the first ask", () => {
    expect(mergePreToolHookDecisions([allow, askA])).toBe(askA);
    expect(mergePreToolHookDecisions([rewriteA, askA])).toBe(askA);
    expect(mergePreToolHookDecisions([askA, rewriteA])).toBe(askA);
    expect(mergePreToolHookDecisions([askA, askB])).toBe(askA);
  });

  it("last updatedInput wins among non-denied, non-asked hooks", () => {
    expect(mergePreToolHookDecisions([rewriteA, rewriteB])).toBe(rewriteB);
    expect(mergePreToolHookDecisions([allow, rewriteA, allow, rewriteB])).toBe(rewriteB);
  });

  it("updatedInput beats a bare allow", () => {
    expect(mergePreToolHookDecisions([allow, rewriteA])).toBe(rewriteA);
    expect(mergePreToolHookDecisions([rewriteA, allow])).toBe(rewriteA);
  });

  it("no hook can un-deny: precedence is preserved under every ordering of a fixed set", () => {
    const set: readonly PreToolHookDecision[] = [allow, askA, denyA, rewriteA];
    const permutations: PreToolHookDecision[][] = [
      [allow, askA, denyA, rewriteA],
      [rewriteA, denyA, askA, allow],
      [askA, rewriteA, allow, denyA],
      [denyA, allow, rewriteA, askA]
    ];
    for (const ordering of permutations) {
      expect(ordering).toHaveLength(set.length);
      expect(mergePreToolHookDecisions(ordering)).toBe(denyA);
    }
  });
});

describe("evaluatePreToolHooks", () => {
  const savedTrustEnv = process.env.GURU_TRUST_PROJECT_HOOKS;

  beforeEach(() => {
    hookMocks.existsSync.mockReset();
    hookMocks.execFile.mockReset();
    clearPreToolHooks();
    delete process.env.GURU_TRUST_PROJECT_HOOKS;
  });

  afterAll(() => {
    if (savedTrustEnv === undefined) {
      delete process.env.GURU_TRUST_PROJECT_HOOKS;
    } else {
      process.env.GURU_TRUST_PROJECT_HOOKS = savedTrustEnv;
    }
  });

  it("allows when no deciding hooks are registered and the project is untrusted", async () => {
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.sh"));
    const decision = await evaluatePreToolHooks("bash", { command: "ls" });
    expect(decision).toEqual({ kind: "allow" });
    // Untrusted project: the project shell hook is never even spawned.
    expect(hookMocks.execFile).not.toHaveBeenCalled();
  });

  it("returns an in-process hook's deny", async () => {
    registerPreToolHook(() => denyA);
    expect(await evaluatePreToolHooks("bash", {})).toBe(denyA);
  });

  it("returns an in-process hook's ask and updatedInput", async () => {
    registerPreToolHook(() => askA);
    expect(await evaluatePreToolHooks("bash", {})).toBe(askA);

    clearPreToolHooks();
    registerPreToolHook(() => rewriteA);
    expect(await evaluatePreToolHooks("bash", {})).toBe(rewriteA);
  });

  it("treats a throwing hook as fail-closed ask and still evaluates later hooks", async () => {
    const calls: string[] = [];
    registerPreToolHook(() => {
      calls.push("first");
      throw new Error("boom");
    });
    registerPreToolHook(() => {
      calls.push("second");
      return allow;
    });

    const decision = await evaluatePreToolHooks("bash", {});
    expect(calls).toEqual(["first", "second"]);
    expect(decision).toEqual({ kind: "ask", reason: "pre-tool hook threw during evaluation" });
  });

  it("merges in-process hooks with the fixed precedence (deny survives a later allow)", async () => {
    registerPreToolHook(() => denyA);
    registerPreToolHook(() => allow);
    registerPreToolHook(() => rewriteA);
    expect(await evaluatePreToolHooks("bash", {})).toBe(denyA);
  });

  it("unregisters a hook through the returned handle", async () => {
    const unregister = registerPreToolHook(() => denyA);
    unregister();
    expect(await evaluatePreToolHooks("bash", {})).toEqual({ kind: "allow" });
  });

  it("runs the trusted project tool-pre.sh hook and parses its deny decision", async () => {
    process.env.GURU_TRUST_PROJECT_HOOKS = "1";
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.sh"));
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '{"decision":"deny","reason":"no root"}\n');
    });

    const decision = await evaluatePreToolHooks("bash", { command: "rm -rf /" });

    expect(hookMocks.execFile).toHaveBeenCalledTimes(1);
    expect(hookMocks.execFile.mock.calls[0]?.[0]).toBe("bash");
    expect(hookMocks.execFile.mock.calls[0]?.[1]).toEqual([join(process.cwd(), ".guru", "hooks", "tool-pre.sh")]);
    expect(hookMocks.execFile.mock.calls[0]?.[2]).toMatchObject({
      env: expect.objectContaining({
        GURU_TOOL_ID: "bash",
        GURU_TOOL_INPUT: JSON.stringify({ command: "rm -rf /" })
      }),
      timeout: expect.any(Number),
      maxBuffer: expect.any(Number)
    });
    expect(decision).toEqual({ kind: "deny", reason: "no root" });
  });

  it("parses a trusted shell hook's updatedInput decision", async () => {
    process.env.GURU_TRUST_PROJECT_HOOKS = "1";
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.sh"));
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '{"decision":"updatedInput","input":{"command":"ls -la"}}');
    });

    expect(await evaluatePreToolHooks("bash", { command: "ls" })).toEqual({
      kind: "updatedInput",
      input: { command: "ls -la" }
    });
  });

  it("runs the trusted project tool-pre.ps1 hook through pwsh argv", async () => {
    process.env.GURU_TRUST_PROJECT_HOOKS = "1";
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.ps1"));
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '{"decision":"allow"}');
    });

    const decision = await evaluatePreToolHooks("read", { path: "a.txt" });

    expect(hookMocks.execFile.mock.calls[0]?.[0]).toBe("pwsh");
    expect(hookMocks.execFile.mock.calls[0]?.[1]).toEqual([
      "-NoProfile",
      "-File",
      join(process.cwd(), ".guru", "hooks", "tool-pre.ps1")
    ]);
    expect(decision).toEqual({ kind: "allow" });
  });

  it("fails closed to ask on malformed shell-hook output (never a silent allow)", async () => {
    process.env.GURU_TRUST_PROJECT_HOOKS = "1";
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.sh"));

    const malformedOutputs = [
      "not json at all",
      '{"decision":"maybe-later"}',
      '{"verdict":"allow"}',
      '{"decision":"updatedInput"}',
      "",
      "   \n  \n"
    ];
    for (const output of malformedOutputs) {
      hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
        callback(null, output);
      });
      const decision = await evaluatePreToolHooks("bash", {});
      expect(decision.kind).toBe("ask");
    }
  });

  it("fails closed to ask when the shell hook process errors", async () => {
    process.env.GURU_TRUST_PROJECT_HOOKS = "1";
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.sh"));
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("exit 2"));
    });

    const decision = await evaluatePreToolHooks("bash", {});
    expect(decision.kind).toBe("ask");
    expect(decision).toEqual({ kind: "ask", reason: "pre-tool hook failed: exit 2" });
  });

  it("merges a shell-hook deny over an in-process allow across lanes", async () => {
    process.env.GURU_TRUST_PROJECT_HOOKS = "1";
    registerPreToolHook(() => allow);
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.sh"));
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '{"decision":"deny","reason":"shell says no"}');
    });

    expect(await evaluatePreToolHooks("bash", {})).toEqual({ kind: "deny", reason: "shell says no" });
  });

  it("does not throw on cyclic tool input and sends the unserializable sentinel to the hook", async () => {
    process.env.GURU_TRUST_PROJECT_HOOKS = "1";
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.sh"));
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '{"decision":"allow"}');
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(evaluatePreToolHooks("bash", cyclic)).resolves.toEqual({ kind: "allow" });
    expect(hookMocks.execFile.mock.calls[0]?.[2]?.env?.GURU_TOOL_INPUT).toBe(
      '{"status":"unknown","error":"unserializable tool result"}'
    );
  });

  it("string tool input passes through to the hook env unchanged", async () => {
    process.env.GURU_TRUST_PROJECT_HOOKS = "1";
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-pre.sh"));
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '{"decision":"ask","reason":"review this"}');
    });

    await evaluatePreToolHooks("bash", "raw string input");
    expect(hookMocks.execFile.mock.calls[0]?.[2]?.env?.GURU_TOOL_INPUT).toBe("raw string input");
  });
});

describe("observer hooks cannot rewrite (structural lane split)", () => {
  const savedTrustEnv = process.env.GURU_TRUST_PROJECT_HOOKS;

  beforeEach(() => {
    hookMocks.existsSync.mockReset();
    hookMocks.execFile.mockReset();
    clearPreToolHooks();
    delete process.env.GURU_TRUST_PROJECT_HOOKS;
  });

  afterAll(() => {
    if (savedTrustEnv === undefined) {
      delete process.env.GURU_TRUST_PROJECT_HOOKS;
    } else {
      process.env.GURU_TRUST_PROJECT_HOOKS = savedTrustEnv;
    }
  });

  it("an on() listener that returns a deny-shaped value has no decision channel", async () => {
    const host = createExtensionHost();
    let observed = false;
    host.registerExtension((api) => {
      api.on(LifecycleEvents.TOOL_EXECUTE, () => {
        observed = true;
        // Observer lane: the bus discards this return value by construction.
        // Even a deny-shaped object here never reaches the merge.
        return { kind: "deny", reason: "observer trying to rewrite" } as unknown as void;
      });
    });
    host.start();

    host.sendMessage(LifecycleEvents.TOOL_EXECUTE, { toolId: "bash", input: {} });
    expect(observed).toBe(true);

    const decision = await evaluatePreToolHooks("bash", {});
    expect(decision).toEqual({ kind: "allow" });
    host.stop();
  });

  it("observer shell hooks (tool-execute) never feed stdout into the decision merge", async () => {
    hookMocks.existsSync.mockImplementation((path) => String(path).endsWith("tool-execute.sh"));
    // The observer hook "prints" a deny to ITS stdout — but the observer lane
    // invokes execFile with a fire-and-forget callback that captures nothing,
    // so there is no path for this text to become a decision.
    hookMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '{"decision":"deny","reason":"observer stdout"}');
    });

    const host = createExtensionHost();
    host.registerExtension(registerShellHooks);
    host.start();
    hookMocks.execFile.mockClear();

    host.sendMessage(LifecycleEvents.TOOL_EXECUTE, { toolId: "bash", input: {} });
    expect(hookMocks.execFile).toHaveBeenCalledTimes(1);
    // Fire-and-forget observer invocation: no timeout/maxBuffer decision-lane
    // options are set on the observer path.
    expect(hookMocks.execFile.mock.calls[0]?.[2]).not.toMatchObject({ timeout: expect.any(Number) });

    const decision = await evaluatePreToolHooks("bash", {});
    expect(decision).toEqual({ kind: "allow" });
    host.stop();
  });
});
