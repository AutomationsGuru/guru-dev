import { defineProviderRoute } from "../../src/providers/registry.js";
import {
  getOperatorAuthSpec,
  isOperatorAuthRoute,
  resolveOperatorAuthPresence,
  OPERATOR_AUTH_SPECS
} from "../../src/model/operatorAuth.js";
import { buildDelegateArgs, buildDelegatePrompt, extractDelegateText, runCliDelegateTurn } from "../../src/model/cliDelegateTurn.js";

const codexRoute = defineProviderRoute({
  providerId: "openai-codex",
  modelId: "gpt-5.5-codex-plan",
  routeId: "openai-codex/gpt-5.5-codex-plan",
  routeType: "operator-provider-plan-auth",
  apiFamily: "openai-responses",
  credentialSource: { type: "native-cli-token", commandName: "codex.cmd", envVarNames: [] },
  status: "needs-login",
  directFirstRank: 1,
  allowedRouterFallback: false
});

describe("operator auth presence (path only)", () => {
  it("classifies plan-auth / native-cli routes as operator-auth", () => {
    expect(isOperatorAuthRoute(codexRoute)).toBe(true);
  });

  it("reports present + delegate when the credential cache exists — value never surfaced", () => {
    const presence = resolveOperatorAuthPresence(codexRoute, {
      home: "/home/op",
      filesExist: (abs) => abs.replace(/\\/gu, "/") === "/home/op/.codex/auth.json"
    });

    expect(presence.present).toBe(true);
    expect(presence.presentPath).toBe(".codex/auth.json");
    expect(presence.delegateCommandName).toBeDefined();
    expect(JSON.stringify(presence)).not.toContain("auth-token");
    expect(JSON.stringify(presence)).not.toContain("secret");
  });

  it("reports login-needed with the exact login command when the cache is absent", () => {
    const presence = resolveOperatorAuthPresence(codexRoute, { home: "/home/op", filesExist: () => false });

    expect(presence.present).toBe(false);
    expect(presence.loginCommand).toBe("codex login");
    expect(presence.summary).toContain("codex login");
  });

  it("maps codex delegation to stdin-based fixed argv (no prompt on the command line)", () => {
    const spec = getOperatorAuthSpec("openai-codex");
    expect(spec?.delegate?.args).toEqual(["exec", "--skip-git-repo-check", "-"]);
    expect(OPERATOR_AUTH_SPECS.some((entry) => entry.providerId === "minimax-oauth")).toBe(true);
  });
});

describe("operator-auth spec ↔ catalog consistency (the login-status split-brain fix)", () => {
  const route = (providerId: string) =>
    defineProviderRoute({
      providerId,
      modelId: "m",
      routeId: `${providerId}/m`,
      routeType: "operator-provider-plan-auth",
      apiFamily: "openai-responses",
      credentialSource: { type: "oauth-cache", filePath: providerId === "zai-coding-cn" ? "~/.zcode/v2/config.json" : "~/.codex/auth.json", cacheTokenPath: "x", envVarNames: [] },
      status: "active",
      directFirstRank: 1,
      allowedRouterFallback: false
    });

  it("zai-coding-cn presence checks the REAL zcode config (not the stale .z-ai/.zai guesses)", () => {
    const spec = getOperatorAuthSpec("zai-coding-cn");
    expect(spec?.cacheRelPaths).toEqual([".zcode/v2/config.json"]);
    const present = resolveOperatorAuthPresence(route("zai-coding-cn"), {
      home: "/home/op",
      filesExist: (abs) => abs.replace(/\\/gu, "/") === "/home/op/.zcode/v2/config.json"
    });
    expect(present.present).toBe(true);
    expect(present.presentPath).toBe(".zcode/v2/config.json");
  });

  it("openai-codex-direct now has a spec sharing the codex login file (was: 'No operator-auth mapping')", () => {
    const spec = getOperatorAuthSpec("openai-codex-direct");
    expect(spec?.cacheRelPaths).toEqual([".codex/auth.json"]);
    const present = resolveOperatorAuthPresence(route("openai-codex-direct"), {
      home: "/home/op",
      filesExist: (abs) => abs.replace(/\\/gu, "/") === "/home/op/.codex/auth.json"
    });
    expect(present.supported).toBe(true); // no longer the unsupported/false path
    expect(present.present).toBe(true);
  });

  it("INVARIANT: every spec that maps to an oauth-cache catalog route checks that route's credential file", () => {
    // A presence spec whose paths diverge from the catalog credentialSource.filePath is
    // exactly the drift that caused the split-brain — pin them together forever.
    const CATALOG_FILE: Record<string, string> = {
      "openai-codex-direct": ".codex/auth.json",
      "zai-coding-cn": ".zcode/v2/config.json",
      "grok-cli": ".grok/auth.json"
    };
    for (const [providerId, rel] of Object.entries(CATALOG_FILE)) {
      const spec = getOperatorAuthSpec(providerId);
      expect(spec, providerId).toBeDefined();
      expect(spec?.cacheRelPaths, providerId).toContain(rel);
    }
  });
});

describe("cli delegate turn", () => {
  it("delegates through the provider CLI with the prompt on stdin and parses the tail", async () => {
    const captured: { command: string; args: readonly string[]; stdin: string } = { command: "", args: [], stdin: "" };
    const result = await runCliDelegateTurn(codexRoute, [
      { role: "system", content: "sys" },
      { role: "user", content: "what model are you?" }
    ], {
      home: "/home/op",
      filesExist: () => true,
      executor: async (command, args, stdin) => {
        captured.command = command;
        captured.args = args;
        captured.stdin = stdin;
        return { exitCode: 0, stdout: "OpenAI Codex v0.142.0\nworkdir: x\n--------\nI am Codex.", stderr: "" };
      }
    });

    expect(captured.command).toMatch(/codex/u);
    expect(captured.args).toContain("-");
    expect(captured.stdin).toContain("what model are you?");
    expect(result.text).toBe("I am Codex.");
    expect(result.apiFamily).toBe("native-cli");
  });

  it("fails honestly when the credential cache is absent (never runs the CLI)", async () => {
    let ran = false;
    await expect(
      runCliDelegateTurn(codexRoute, [{ role: "user", content: "hi" }], {
        filesExist: () => false,
        executor: async () => {
          ran = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      })
    ).rejects.toThrow(/codex login/u);
    expect(ran).toBe(false);
  });

  it("surfaces a non-zero exit as an honest error", async () => {
    await expect(
      runCliDelegateTurn(codexRoute, [{ role: "user", content: "hi" }], {
        filesExist: () => true,
        executor: async () => ({ exitCode: 1, stdout: "", stderr: "not logged in" })
      })
    ).rejects.toThrow(/exit 1/u);
  });
});

describe("extractDelegateText", () => {
  it("strips banner/metadata noise and keeps the answer", () => {
    const raw = "2026-07-02T04:38:32Z ERROR rmcp: noise\nOpenAI Codex v0.142.0\n--------\nworkdir: D:\\x\nmodel: gpt-5.5\nHere is the answer.";
    expect(extractDelegateText(raw)).toBe("Here is the answer.");
  });
});

describe("buildDelegatePrompt", () => {
  it("prepends system + history and ends with the latest user ask", () => {
    const prompt = buildDelegatePrompt([
      { role: "system", content: "SYS" },
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" }
    ]);
    expect(prompt.startsWith("SYS")).toBe(true);
    expect(prompt).toContain("first");
    expect(prompt.trimEnd().endsWith("second")).toBe(true);
  });
});

describe("codex delegate sandbox governance", () => {
  const codex = OPERATOR_AUTH_SPECS.find((spec) => spec.providerId === "openai-codex");

  it("maps /allow-writes to exactly two sandbox tiers — never a full-access tier", () => {
    expect(codex?.delegate?.sandboxArgs).toEqual({
      readOnly: ["--sandbox", "read-only"],
      workspaceWrite: ["--sandbox", "workspace-write"]
    });
    const everything = JSON.stringify(codex?.delegate);
    expect(everything).not.toContain("danger");
    expect(everything).not.toContain("bypass");
  });

  it("composes read-only argv by default, stdin marker last", () => {
    expect(buildDelegateArgs(codex!.delegate!, {})).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-"
    ]);
  });

  it("composes workspace-write argv with cwd pin when writes are allowed", () => {
    expect(buildDelegateArgs(codex!.delegate!, { writesAllowed: true, cwd: "D:/work/proj" })).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--cd",
      "D:/work/proj",
      "-"
    ]);
  });

  it("explicit writesAllowed:false composes read-only even with a cwd", () => {
    const args = buildDelegateArgs(codex!.delegate!, { writesAllowed: false, cwd: "D:/x" });
    expect(args).toContain("read-only");
    expect(args).not.toContain("workspace-write");
  });
});
