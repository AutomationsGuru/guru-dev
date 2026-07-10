import { describe, expect, it } from "vitest";

import { ProviderCliConfigSchema } from "../../src/provider-cli/schemas.js";
import type { ProviderCliStatusExecutor } from "../../src/provider-cli/status.js";
import {
  createProviderCliRunTool,
  createProviderCliStatusTool
} from "../../src/tools/builtins/providerCliTools.js";

const config = ProviderCliConfigSchema.parse({
  id: "codex",
  commandName: "codex.cmd",
  statusArgs: ["--version"],
  policy: "explicit-run-allowed"
});
const statusOnly = ProviderCliConfigSchema.parse({
  id: "gcloud",
  commandName: "gcloud",
  policy: "status-only"
});

const readyExecutor: ProviderCliStatusExecutor = {
  commandExists: () => true,
  version: async () => ({ exitCode: 0, stdout: "codex 9.9.9\n", stderr: "" })
};

describe("provider_cli_status tool", () => {
  it("returns a single report when id is set", async () => {
    const tool = createProviderCliStatusTool({
      configs: [config],
      env: {},
      executor: readyExecutor
    });
    const out = (await tool.execute({ id: "codex" }, {})) as {
      reports: { status: string; version?: string }[];
      summary: string;
    };
    expect(out.reports).toHaveLength(1);
    expect(out.reports[0]?.status).toBe("ready");
    expect(out.reports[0]?.version).toBe("codex 9.9.9");
    expect(out.summary).toContain("ready");
  });

  it("returns the full matrix when id is omitted", async () => {
    const tool = createProviderCliStatusTool({
      configs: [config, statusOnly],
      env: {},
      executor: readyExecutor
    });
    const out = (await tool.execute({}, {})) as { reports: unknown[]; summary: string };
    expect(out.reports).toHaveLength(2);
    expect(out.summary).toMatch(/2 provider CLI/);
  });
});

describe("provider_cli_run tool", () => {
  it("defaults to dry-run without executing", async () => {
    let ran = false;
    const tool = createProviderCliRunTool({
      configs: [config],
      env: {},
      executor: readyExecutor,
      runExecutor: async () => {
        ran = true;
        return { exitCode: 0, stdout: "hi", stderr: "" };
      }
    });
    const out = await tool.execute(
      {
        id: "codex",
        prompt: "hello world",
        dryRun: true,
        userApproved: false,
        redactOutput: true,
        timeoutMs: 30_000
      },
      {}
    );
    expect(out.status).toBe("dry-run");
    expect(out.summary).toContain("codex.cmd");
    expect(out.summary).toContain("hello");
    expect(ran).toBe(false);
  });

  it("blocks live run without userApproved", async () => {
    const tool = createProviderCliRunTool({
      configs: [config],
      env: {},
      executor: readyExecutor,
      runExecutor: async () => ({ exitCode: 0, stdout: "nope", stderr: "" })
    });
    const out = await tool.execute(
      {
        id: "codex",
        prompt: "x",
        dryRun: false,
        userApproved: false,
        redactOutput: true,
        timeoutMs: 30_000
      },
      {}
    );
    expect(out.status).toBe("blocked");
    expect(out.summary).toMatch(/userApproved/i);
  });

  it("blocks status-only CLIs even when approved", async () => {
    const tool = createProviderCliRunTool({
      configs: [statusOnly],
      env: {},
      executor: readyExecutor
    });
    const out = await tool.execute(
      {
        id: "gcloud",
        prompt: "list",
        dryRun: false,
        userApproved: true,
        redactOutput: true,
        timeoutMs: 30_000
      },
      {}
    );
    // status-only path returns dry-run with explanation rather than live execute
    expect(out.status).toBe("dry-run");
    expect(out.summary).toMatch(/status-only/i);
  });

  it("executes when policy allows and userApproved + dryRun=false", async () => {
    const tool = createProviderCliRunTool({
      configs: [config],
      env: {},
      executor: readyExecutor,
      runExecutor: async () => ({
        exitCode: 0,
        stdout: "ok sk-abcdefghijklmnopqrstuvwxyz1234",
        stderr: ""
      })
    });
    const out = await tool.execute(
      {
        id: "codex",
        prompt: "ship it",
        dryRun: false,
        userApproved: true,
        redactOutput: true,
        timeoutMs: 30_000
      },
      {}
    );
    expect(out.status).toBe("succeeded");
    expect(out.stdout).toContain("[REDACTED_KEY]");
    expect(out.stdout).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
  });
});
