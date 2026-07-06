import { createLineStreamer, runCliDelegateTurn } from "../../src/model/cliDelegateTurn.js";
import { defineProviderRoute } from "../../src/providers/registry.js";

describe("createLineStreamer", () => {
  it("emits complete non-noise lines as chunks arrive, filtering banner noise", () => {
    const emitted: string[] = [];
    const streamer = createLineStreamer((text) => emitted.push(text));

    streamer.push("OpenAI Codex v0.142.0\nHello ");
    streamer.push("world\n2026-07-02T04:38:32Z ERROR rmcp: noise\nFinal line");
    streamer.flush();

    expect(emitted).toEqual(["Hello world\n", "Final line\n"]);
  });
});

describe("runCliDelegateTurn streaming", () => {
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

  it("forwards live output chunks through onToken (noise stripped)", async () => {
    const streamed: string[] = [];
    const result = await runCliDelegateTurn(codexRoute, [{ role: "user", content: "hi" }], {
      filesExist: () => true,
      onToken: (chunk) => streamed.push(chunk),
      executor: async (_command, _args, _stdin, options) => {
        options.onOutput?.("OpenAI Codex v0.142.0\n");
        options.onOutput?.("Answer line one\n");
        options.onOutput?.("Answer line two\n");
        return { exitCode: 0, stdout: "OpenAI Codex v0.142.0\nAnswer line one\nAnswer line two\n", stderr: "" };
      }
    });

    expect(streamed.join("")).toBe("Answer line one\nAnswer line two\n");
    expect(result.text).toContain("Answer line one");
  });
});
