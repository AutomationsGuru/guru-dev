import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json" with { type: "json" };
import {
  GURUHARNESS_RUNTIME_NAME,
  GURUHARNESS_VERSION,
  getRuntimeInfo,
  readPackageVersionFromMetadata
} from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tscEntrypoint = resolve(repoRoot, "node_modules/typescript/bin/tsc");
const expectedCliOutput = `${GURUHARNESS_RUNTIME_NAME} ${packageJson.version} — repo-aware agent harness runtime nucleus`;

function toMsysPath(path: string): string {
  return path.replace(/^([A-Za-z]):[\\/]/u, (_match, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/gu, "/");
}

describe("getRuntimeInfo", () => {
  it("should export the GuruHarness runtime identity", () => {
    const runtimeInfo = getRuntimeInfo();

    expect(runtimeInfo).toEqual({
      name: GURUHARNESS_RUNTIME_NAME,
      version: packageJson.version,
      capability: "repo-aware agent harness runtime nucleus"
    });
  });

  it("should keep the exported version aligned with package metadata", () => {
    expect(GURUHARNESS_VERSION).toBe(packageJson.version);
  });

  it("should reject package metadata without a usable version", () => {
    expect(() => readPackageVersionFromMetadata({})).toThrow(
      "GuruHarness package metadata must include a version string."
    );
    expect(() => readPackageVersionFromMetadata({ version: "" })).toThrow(
      "GuruHarness package metadata must include a version string."
    );
  });
});

describe("cli", () => {
  it("should print the runtime name, version, and capability", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();

    expect(output).toBe(expectedCliOutput);
  });

  it("should print the expected output from the built CLI", () => {
    execFileSync(process.execPath, [tscEntrypoint, "-p", "tsconfig.build.json"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    const output = execFileSync(process.execPath, ["dist/cli.js"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();

    expect(output).toBe(expectedCliOutput);
  }, 60_000);

  it("should print the self-build plan command output", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "self-build-plan"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const parsed = JSON.parse(output) as {
      config?: { status?: string; verdict?: string };
      nextTask?: { id?: string };
      taskCount?: number;
    };

    expect(parsed.config).toMatchObject({ status: "loaded", verdict: "GREEN" });
    expect(parsed.nextTask?.id).toBe("api-startup-dogfood");
    expect(parsed.taskCount).toBe(38);
  });

  it("should print the dev-cycle dry-run plan and execute nothing", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "self-build-run", "--dry-run", "--task-id", "preview-task"], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(output).toContain("Dev-cycle plan");
    expect(output).toContain("preview-task");
    expect(output).toContain("SELECT");
    expect(output).toContain("DRY RUN");
    // TEST lists the repo's OWN discovered gates (proof discovery ran, read-only).
    expect(output).toMatch(/npm run test/u);
  });

  it("should print run help with runtime hardening and git flags", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(output).toContain("Usage: guruharness run [options]");
    expect(output).toContain("--allow-dirty-workspace");
    expect(output).toContain("--allow-risky-paths");
    expect(output).toContain("--max-planner-retries <n>");
    expect(output).toContain("--git-path <path>");
  });

  it("should print the maintenance audit command output", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "maintenance-audit"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const parsed = JSON.parse(output) as { verdict?: string; checks?: { id: string; status: string }[] };

    // main is now a pristine runtime package (no AGENTS.md / docs by design), so guru
    // auditing its OWN repo flags exactly the two working-repo doc surfaces; the audit's
    // GREEN path is covered against fixture repos in tests/maintenance/audit.test.ts.
    expect(parsed.checks).toHaveLength(9);
    const failed = (parsed.checks ?? []).filter((c) => c.status === "failed").map((c) => c.id).sort();
    expect(failed).toEqual(["documentation", "repo-context"]);
  });

  it("should print the HERE/THERE direction check", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "direction-check"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const parsed = JSON.parse(output) as { verdict?: string; task?: { id?: string }; there?: string };

    expect(parsed.verdict).toBe("GREEN");
    expect(parsed.task?.id).toBe("api-startup-dogfood");
    expect(parsed.there).toContain("independent agent harness");
  });

  it("should start a harness runtime session", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "session-start", "--skill", "guruharness-self-build"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const parsed = JSON.parse(output) as {
      status?: string;
      task?: { id?: string };
      tools?: Array<{ id?: string }>;
      skills?: { loaded?: Array<{ manifest?: { id?: string } }> };
    };

    expect(parsed.status).toBe("ready");
    expect(parsed.task?.id).toBe("api-startup-dogfood");
    expect(parsed.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "repo.context.resolve" }),
        expect.objectContaining({ id: "fs.edit.apply" }),
        expect.objectContaining({ id: "shell.command.run" }),
        expect.objectContaining({ id: "github.pr.status" }),
        expect.objectContaining({ id: "github.pr.comment" }),
        expect.objectContaining({ id: "github.pr.review" }),
        expect.objectContaining({ id: "operational.state.write" }),
        expect.objectContaining({ id: "operational.decision.upsert" }),
        expect.objectContaining({ id: "operational.implementation.create" })
      ])
    );
    expect(parsed.skills?.loaded).toEqual(
      expect.arrayContaining([expect.objectContaining({ manifest: expect.objectContaining({ id: "guruharness-self-build" }) })])
    );
  });

  it("should execute one registered tool through the CLI", () => {
    const msysRepoRoot = toMsysPath(repoRoot);
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "tool-run",
        "--tool-id",
        "repo.context.resolve",
        "--input-json",
        JSON.stringify({ cwd: msysRepoRoot })
      ],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    ).trim();
    const parsed = JSON.parse(output) as { session?: { status?: string }; observation?: { status?: string; output?: { repoRoot?: string } } };

    expect(parsed.session).toMatchObject({ status: "ready" });
    expect(parsed.observation).toMatchObject({ status: "succeeded", output: { repoRoot } });
  });

  it("should print session list help", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "session-list", "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(output).toContain("Usage: guruharness session-list --api-url <url> [--limit <n>]");
    expect(output).toContain("Fetches recent persisted API sessions");
  });

  it("should print session continuation help", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "session-continue", "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(output).toContain("Usage: guruharness session-continue --api-url <url> --session-id <id>");
    expect(output).toContain("Fetches safe suggested commands");
  });

  it("should print session inspection help", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "session-inspect", "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(output).toContain("Usage: guruharness session-inspect --api-url <url> --session-id <id>");
    expect(output).toContain("Fetches the API session inspection helper");
  });

  it("should execute one registered tool with input loaded from a JSON file", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-cli-input-"));
    const inputPath = join(tempRoot, "input.json");

    try {
      writeFileSync(inputPath, JSON.stringify({ cwd: toMsysPath(repoRoot) }));
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "tool-run", "--tool-id", "repo.context.resolve", "--input-file", inputPath],
        {
          cwd: repoRoot,
          encoding: "utf8"
        }
      ).trim();
      const parsed = JSON.parse(output) as { observation?: { status?: string; output?: { repoRoot?: string } } };

      expect(parsed.observation).toMatchObject({ status: "succeeded", output: { repoRoot } });
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("should print the configured skill catalog", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "skills-list"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const parsed = JSON.parse(output) as { skills?: Array<{ id?: string }> };

    expect(parsed.skills).toEqual(expect.arrayContaining([expect.objectContaining({ id: "guruharness-self-build" })]));
  });

  it("should filter the portfolio dogfood smoke by orchestrator and tier", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/portfolioDogfoodSmoke.ts", "--orchestrator", "cyberchef", "--tier", "tier-2"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const parsed = JSON.parse(output) as { orchestrator?: string; tier?: string; repoCount?: number; skipped?: Array<{ label?: string; reason?: string }> };

    expect(parsed).toMatchObject({ orchestrator: "cyberchef", tier: "tier-2", repoCount: 0 });
    expect(parsed.skipped).toEqual([{ label: "cyberchef-tier2", orchestrator: "cyberchef", tier: "tier-2", reason: "remote target requires --include-remote" }]);
  });

  it("should reject invalid portfolio dogfood smoke tier filters", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/portfolioDogfoodSmoke.ts", "--tier", "tier-3"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid --tier: tier-3. Allowed values: core, tier-2");
  });

  it("should start the API surface for a bounded time window", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "api", "--timeout-ms", "40", "--host", "127.0.0.1", "--port", "4101"],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    ).trim();
    const parsed = JSON.parse(output) as { status?: string; url?: string; endpoints?: string[] };

    expect(parsed.status).toBe("running");
    expect(parsed.url).toContain("http://127.0.0.1:");
    expect(parsed.endpoints).toEqual(expect.arrayContaining(["/", "/sessions", "/sessions/:sessionId/inspect", "/sessions/:sessionId/continue", "/tool-run"]));
  });

  it("should render the TUI help output in command mode", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "tui", "--command", "help"],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    ).trim();

    expect(output).toContain("guruharness TUI commands");
  });

  it("should load a skill through the CLI with an explicit config path", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-cli-skills-"));

    try {
      mkdirSync(join(tempRoot, "skills", "custom-skill"), { recursive: true });
      writeFileSync(
        join(tempRoot, "skills", "custom-skill", "SKILL.md"),
        "---\nname: custom-skill\ndescription: Custom skill.\n---\n# Custom Skill\n"
      );
      const configPath = join(tempRoot, "guruharness.config.json");
      writeFileSync(configPath, JSON.stringify({ skillDirectories: ["skills"] }));

      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "skill-load", "custom-skill", "--config", configPath],
        {
          cwd: repoRoot,
          encoding: "utf8"
        }
      ).trim();
      const parsed = JSON.parse(output) as { manifest?: { id?: string } };

      expect(parsed.manifest?.id).toBe("custom-skill");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("should run the practical command lifecycle via the run command", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-cli-run-"));

    try {
      const configPath = join(tempRoot, "guruharness.config.json");
      writeFileSync(configPath, "{}");

      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "run",
          "--config",
          configPath,
          "--task-id",
          "run-command-lifecycle",
          "--objective",
          "Run command lifecycle smoke test",
          "--allow-dirty-workspace"
        ],
        {
          cwd: repoRoot,
          encoding: "utf8"
        }
      ).trim();
      const parsed = JSON.parse(output) as {
        verdict?: string;
        session?: { task?: { id?: string } };
        planner?: { objective?: string; blockers?: string[] };
      };

      expect(parsed.verdict).toBe("RED");
      expect(parsed.session?.task?.id).toBe("run-command-lifecycle");
      expect(parsed.planner?.objective).toBe("Run command lifecycle smoke test");
      expect(parsed.planner?.blockers?.[0]).toBe("No planner model was injected and no usable plannerModel config is available.");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
