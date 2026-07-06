import { runTuiCommand } from "../../src/surfaces/tui.js";

describe("runTuiCommand", () => {
  it("executes plan, direction, session, and run command handlers", async () => {
    const events: Record<string, unknown> = {};

    const plan = async (request: { readonly configPath?: string; readonly cwd?: string }) => ({
      route: "plan",
      ...request
    });

    const direction = async (request: { readonly configPath?: string; readonly cwd?: string }) => ({
      route: "direction",
      ...request
    });

    const sessionStart = async (request: unknown) => {
      events.session = request;

      return { route: "session", request };
    };

    const run = async (request: unknown) => {
      events.run = request;

      return { route: "run", request };
    };

    const context = {
      configPath: "default-config.json",
      handlers: {
        plan,
        direction,
        sessionStart,
        run
      }
    };

    const planResult = await runTuiCommand("plan --cwd /tmp/plan", context);
    expect(planResult.shouldExit).toBe(false);
    expect(planResult.output).toContain("\"route\": \"plan\"");
    expect(planResult.output).toContain("/tmp/plan");

    const directionResult = await runTuiCommand("direction --config alt-config.json", context);
    expect(directionResult.shouldExit).toBe(false);
    expect(directionResult.output).toContain("alt-config.json");

    const sessionResult = await runTuiCommand("session --task-id api-tui-surfaces --target /tmp/project --skill core --project test-project", context);
    expect(sessionResult.shouldExit).toBe(false);
    expect(sessionResult.output).toContain("\"route\": \"session\"");
    expect(events.session).toMatchObject({
      configPath: "default-config.json",
      taskId: "api-tui-surfaces",
      targetPath: "/tmp/project",
      skillIds: ["core"],
      projectSlug: "test-project"
    });

    const runResult = await runTuiCommand(
      "run --task-id api-tui-surfaces --objective Surface-command --max-planner-steps 6 --max-planner-retries 2 --resume-session session-123 --allow-dirty-workspace --allow-risky-paths --skip-review-gate --git --git-live --git-branch feature/api --git-path src --git-path tests",
      context
    );
    expect(runResult.shouldExit).toBe(false);
    expect(runResult.output).toContain("\"route\": \"run\"");
    expect(events.run).toMatchObject({
      taskId: "api-tui-surfaces",
      objective: "Surface-command",
      maxPlannerSteps: 6,
      maxPlannerRetries: 2,
      resumeSessionId: "session-123",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      includeReviewGate: false,
      git: {
        enabled: true,
        dryRun: false,
        branchName: "feature/api",
        paths: ["src", "tests"]
      }
    });
  });

  it("supports help and exit commands", async () => {
    const help = await runTuiCommand("help");
    expect(help.shouldExit).toBe(false);
    expect(help.output).toContain("guruharness TUI commands");
    expect(help.output).toContain("--git-path path]...");

    const bye = await runTuiCommand("exit");
    expect(bye.shouldExit).toBe(true);
    expect(bye.output).toContain("Goodbye from GuruHarness TUI");
  });
});
