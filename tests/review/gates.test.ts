import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessConfigSchema } from "../../src/config/schema.js";
import {
  createCommandGates,
  executeCommand,
  runReviewGates,
  type CommandExecutor
} from "../../src/review/gates.js";
import { createReviewGatesTool } from "../../src/tools/builtins/reviewGatesTool.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("createCommandGates", () => {
  it("should include validation gates and the configured review gate", () => {
    const gates = createCommandGates(createConfig(), true);

    expect(gates.map((gate) => `${gate.kind}:${gate.name}`)).toEqual(["validation:test", "review:command"]);
  });

  it("should omit the review gate when requested", () => {
    const gates = createCommandGates(createConfig(), false);

    expect(gates.map((gate) => gate.kind)).toEqual(["validation"]);
  });
});

describe("runReviewGates", () => {
  it("should return GREEN when every required gate passes", async () => {
    const report = await runReviewGates(createConfig(), { executor: createFakeExecutor() });

    expect(report).toMatchObject({
      verdict: "GREEN",
      passed: 2,
      failed: 0,
      summary: "GREEN: 2 gate(s) passed, 0 gate(s) failed."
    });
    expect(report.results.map((result) => result.status)).toEqual(["passed", "passed"]);
  });

  it("should return RED when a required gate fails", async () => {
    const config = createConfig({ validationCommand: ["fail"] });

    const report = await runReviewGates(config, { executor: createFakeExecutor() });

    expect(report.verdict).toBe("RED");
    expect(report.failed).toBe(1);
    expect(report.results[0]).toMatchObject({ name: "test", status: "failed", required: true });
  });

  it("should return YELLOW when only optional gates fail", async () => {
    const config = createConfig({ validationCommand: ["fail"], validationRequired: false });

    const report = await runReviewGates(config, { executor: createFakeExecutor() });

    expect(report.verdict).toBe("YELLOW");
    expect(report.results[0]).toMatchObject({ status: "failed", required: false });
  });

  it("should return YELLOW when no gates are configured", async () => {
    const config = HarnessConfigSchema.parse({ validationCommands: [] });

    const report = await runReviewGates(config, { includeReviewGate: false, executor: createFakeExecutor() });

    expect(report.verdict).toBe("YELLOW");
    expect(report.summary).toBe("YELLOW: 0 gate(s) passed, 0 gate(s) failed.");
  });

  it("should convert thrown executor errors into failed gate results", async () => {
    const executor: CommandExecutor = async () => {
      throw new Error("executor failed");
    };

    const report = await runReviewGates(createConfig(), { includeReviewGate: false, executor });

    expect(report.verdict).toBe("RED");
    expect(report.results[0]).toMatchObject({ status: "failed", stderr: "executor failed" });
  });
});

describe("executeCommand", () => {
  it("should run a command without invoking a shell", async () => {
    const result = await executeCommand([process.execPath, "-e", "console.log('ok')"], {
      gate: {
        kind: "validation",
        name: "node-smoke",
        command: [process.execPath, "-e", "console.log('ok')"],
        required: true
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});

describe("createReviewGatesTool", () => {
  it("should run review gates through the tool registry", async () => {
    const root = makeTempDirectory();
    const configPath = join(root, "guruharness.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        validationCommands: [{ name: "unit", command: ["pass"], required: true }],
        reviewGate: { provider: "command", command: ["pass"], required: true }
      })
    );
    const registry = createToolRegistry([createReviewGatesTool(createFakeExecutor())]);

    const observation = await executeRegisteredTool(registry, "review.gates.run", { configPath, includeReviewGate: false });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({
      config: { status: "loaded", verdict: "GREEN" },
      report: { verdict: "GREEN", passed: 1, failed: 0 }
    });
  });

  it("should return RED without running gates when config is invalid", async () => {
    const root = makeTempDirectory();
    const configPath = join(root, "guruharness.config.json");
    const executedCommands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      executedCommands.push([...command]);

      return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    };
    writeFileSync(configPath, JSON.stringify({ approvalPolicy: { allowLocalMerge: "yes" } }));
    const registry = createToolRegistry([createReviewGatesTool(executor)]);

    const observation = await executeRegisteredTool(registry, "review.gates.run", { configPath });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({
      config: { status: "invalid", verdict: "RED" },
      report: { verdict: "RED", passed: 0, failed: 0 }
    });
    expect(executedCommands).toHaveLength(0);
  });
});

function createConfig(
  options: { readonly validationCommand?: readonly string[]; readonly validationRequired?: boolean } = {}
) {
  return HarnessConfigSchema.parse({
    validationCommands: [
      { name: "test", command: options.validationCommand ?? ["pass"], required: options.validationRequired ?? true }
    ],
    reviewGate: { provider: "command", command: ["pass"], required: true }
  });
}

function createFakeExecutor(): CommandExecutor {
  return async (command) => {
    const commandName = command[0] ?? "";

    return {
      exitCode: commandName === "fail" ? 1 : 0,
      stdout: command.join(" "),
      stderr: commandName === "fail" ? "failed" : "",
      durationMs: 1
    };
  };
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-review-gates-"));
  tempDirectories.push(directory);

  return directory;
}
