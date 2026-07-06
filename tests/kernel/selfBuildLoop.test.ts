import {
  applySelfBuildProgress,
  createDryRunSelfBuildExecutor,
  createSelfBuildState,
  planNextSelfBuildTask,
  runSelfBuildLoop,
  type SelfBuildState
} from "../../src/kernel/selfBuildLoop.js";

describe("createSelfBuildState", () => {
  it("should define a bounded parity backlog", () => {
    const state = createSelfBuildState();

    expect(state.referenceRuntime).toBe("a reference agent runtime");
    expect(state.here).toContain("validated harness substrate");
    expect(state.there).toContain("independent agent harness");
    expect(state.constraints).toContain("Every new task starts by reading HERE and THERE and proving the task moves GuruHarness toward THERE.");
    expect(state.tasks.map((task) => task.id)).toEqual([
      "capture-operating-contract",
      "core-result-contracts",
      "supabase-operational-store",
      "self-build-loop",
      "config-loader",
      "tool-registry",
      "repo-context-layer",
      "review-gates",
      "git-pr-automation",
      "maintenance-loop",
      "supabase-runtime-adapter",
      "skill-loader",
      "direction-gate",
      "harness-runtime-nucleus",
      "planner-runtime",
      "self-build-executor",
      "model-adapter",
      "session-persistence",
      "run-command-lifecycle",
      "api-tui-surfaces",
      "runtime-hardening",
      "provider-fallback-playbook",
      "long-running-observability",
      "operator-recovery-workflows",
      "tool-execution-expansion",
      "github-and-operational-tool-expansion",
      "end-to-end-harness-dogfood",
      "operator-ergonomics-polish",
      "api-resumable-sessions",
      "api-session-events",
      "session-inspection-helper",
      "persisted-session-timeline-inspection",
      "session-listing-helper",
      "session-continuation-helper",
      "session-continuation-dogfood",
      "operator-continuity-playbook",
      "api-operator-startup-playbook",
      "api-startup-dogfood"
    ]);
  });
});

describe("applySelfBuildProgress", () => {
  it("should preserve task statuses when progress is empty", () => {
    const state = createSelfBuildState();
    const progressedState = applySelfBuildProgress(state, []);

    expect(progressedState.tasks).toEqual(state.tasks);
    expect(progressedState.objective).toBe(state.objective);
  });

  it("should ignore unknown completed task ids", () => {
    const state = createSelfBuildState();
    const progressedState = applySelfBuildProgress(state, ["not-a-real-task"]);

    expect(progressedState.tasks.every((task) => task.status === "ready")).toBe(true);
  });

  it("should mark known completed task ids as done without changing other tasks", () => {
    const state = createSelfBuildState();
    const progressedState = applySelfBuildProgress(state, ["capture-operating-contract"]);

    expect(progressedState.tasks.find((task) => task.id === "capture-operating-contract")?.status).toBe("done");
    expect(progressedState.tasks.find((task) => task.id === "core-result-contracts")?.status).toBe("ready");
  });
});

describe("planNextSelfBuildTask", () => {
  it("should select the highest-priority ready task with completed dependencies", () => {
    const state = createSelfBuildState();
    const nextTask = planNextSelfBuildTask(state);

    expect(nextTask?.id).toBe("capture-operating-contract");
  });

  it("should not select tasks with incomplete dependencies", () => {
    const state = withTaskStatus(createSelfBuildState(), "capture-operating-contract", "done");
    const nextTask = planNextSelfBuildTask(state);

    expect(nextTask?.id).toBe("core-result-contracts");
  });

  it("should apply persisted progress before selecting the next task", () => {
    const state = applySelfBuildProgress(createSelfBuildState(), [
      "capture-operating-contract",
      "core-result-contracts",
      "supabase-operational-store",
      "self-build-loop",
      "config-loader"
    ]);
    const nextTask = planNextSelfBuildTask(state);

    expect(nextTask?.id).toBe("tool-registry");
  });

  it("should enforce the post-maintenance dependency chain", () => {
    const completedThroughMaintenance = [
      "capture-operating-contract",
      "core-result-contracts",
      "supabase-operational-store",
      "self-build-loop",
      "config-loader",
      "tool-registry",
      "repo-context-layer",
      "review-gates",
      "git-pr-automation",
      "maintenance-loop"
    ];
    const supabaseReadyState = applySelfBuildProgress(createSelfBuildState(), completedThroughMaintenance);

    expect(planNextSelfBuildTask(supabaseReadyState)?.id).toBe("supabase-runtime-adapter");

    const skillLoaderReadyState = withTaskStatus(supabaseReadyState, "supabase-runtime-adapter", "done");

    expect(planNextSelfBuildTask(skillLoaderReadyState)?.id).toBe("skill-loader");

    const directionGateReadyState = withTaskStatus(skillLoaderReadyState, "skill-loader", "done");

    expect(planNextSelfBuildTask(directionGateReadyState)?.id).toBe("direction-gate");

    const runtimeReadyState = withTaskStatus(directionGateReadyState, "direction-gate", "done");
    const runtimeTask = planNextSelfBuildTask(runtimeReadyState);

    expect(runtimeTask?.id).toBe("harness-runtime-nucleus");
    expect(runtimeTask?.thereContribution).toBe(
      "Introduces the actual harness runtime session nucleus that turns the existing primitives into an independent agent harness foundation."
    );

    const plannerReadyState = withTaskStatus(runtimeReadyState, "harness-runtime-nucleus", "done");
    const plannerTask = planNextSelfBuildTask(plannerReadyState);

    expect(plannerTask?.id).toBe("planner-runtime");
    expect(plannerTask?.thereContribution).toBe(
      "Adds model-backed planning and tool orchestration for practical harness sessions."
    );

    const dogfoodReadyState = withTaskStatus(plannerReadyState, "planner-runtime", "done");
    const dogfoodTask = planNextSelfBuildTask(dogfoodReadyState);

    expect(dogfoodTask?.id).toBe("self-build-executor");
    expect(dogfoodTask?.thereContribution).toBe(
      "Dogfoods the harness runtime for construction work while keeping self-build as an internal mode, not the product target."
    );

    const postDogfoodState = withTaskStatus(dogfoodReadyState, "self-build-executor", "done");
    const modelTask = planNextSelfBuildTask(postDogfoodState);

    expect(modelTask?.id).toBe("model-adapter");
    expect(modelTask?.thereContribution).toBe("Turns injected planner contracts into actual model-backed harness execution.");

    const postModelState = withTaskStatus(postDogfoodState, "model-adapter", "done");
    const sessionTask = planNextSelfBuildTask(postModelState);

    expect(sessionTask?.id).toBe("session-persistence");
    expect(sessionTask?.thereContribution).toBe(
      "Lets GuruHarness resume and audit harness sessions instead of relying on in-memory runtime state."
    );

    const postSessionState = withTaskStatus(postModelState, "session-persistence", "done");
    const lifecycleTask = planNextSelfBuildTask(postSessionState);

    expect(lifecycleTask?.id).toBe("run-command-lifecycle");
    expect(lifecycleTask?.thereContribution).toBe(
      "Creates the first daily-usable GuruHarness command for end-to-end agent work."
    );

    const postLifecycleState = withTaskStatus(postSessionState, "run-command-lifecycle", "done");
    const apiTask = planNextSelfBuildTask(postLifecycleState);

    expect(apiTask?.id).toBe("api-tui-surfaces");
    expect(apiTask?.thereContribution).toBe(
      "Moves GuruHarness from library/CLI primitives toward practical interactive harness usage."
    );

    const postApiState = withTaskStatus(postLifecycleState, "api-tui-surfaces", "done");
    const hardeningTask = planNextSelfBuildTask(postApiState);

    expect(hardeningTask?.id).toBe("runtime-hardening");
    expect(hardeningTask?.thereContribution).toBe("Improves reliability and safety for long-running autonomous harness work.");

    const postHardeningState = withTaskStatus(postApiState, "runtime-hardening", "done");
    const providerFallbackTask = planNextSelfBuildTask(postHardeningState);

    expect(providerFallbackTask?.id).toBe("provider-fallback-playbook");
    expect(providerFallbackTask?.thereContribution).toBe(
      "Turns the basic fallback mechanism into a trustworthy long-running autonomous harness capability."
    );

    const postProviderFallbackState = withTaskStatus(postHardeningState, "provider-fallback-playbook", "done");
    const observabilityTask = planNextSelfBuildTask(postProviderFallbackState);

    expect(observabilityTask?.id).toBe("long-running-observability");
    expect(observabilityTask?.thereContribution).toBe(
      "Makes GuruHarness safer to dogfood on long autonomous runs by exposing continuity and recovery evidence."
    );

    const postObservabilityState = withTaskStatus(postProviderFallbackState, "long-running-observability", "done");
    const recoveryTask = planNextSelfBuildTask(postObservabilityState);

    expect(recoveryTask?.id).toBe("operator-recovery-workflows");
    expect(recoveryTask?.thereContribution).toBe(
      "Turns observability evidence into practical operator controls for recovering autonomous harness runs."
    );

    const postRecoveryState = withTaskStatus(postObservabilityState, "operator-recovery-workflows", "done");
    const toolExpansionTask = planNextSelfBuildTask(postRecoveryState);

    expect(toolExpansionTask?.id).toBe("tool-execution-expansion");
    expect(toolExpansionTask?.thereContribution).toBe(
      "Broadens GuruHarness from planning/recovery substrate into a practical AI harness that can perform real bounded file and command work."
    );

    const completedState = withTaskStatus(postRecoveryState, "tool-execution-expansion", "done");
    const followUpToolTask = planNextSelfBuildTask(completedState);

    expect(followUpToolTask?.id).toBe("github-and-operational-tool-expansion");
    expect(followUpToolTask?.thereContribution).toBe(
      "Completes the practical runtime tool breadth needed for review collaboration and operational state updates."
    );

    const postFollowUpToolState = withTaskStatus(completedState, "github-and-operational-tool-expansion", "done");
    const dogfoodReadinessTask = planNextSelfBuildTask(postFollowUpToolState);

    expect(dogfoodReadinessTask?.id).toBe("end-to-end-harness-dogfood");
    expect(dogfoodReadinessTask?.thereContribution).toBe(
      "Moves GuruHarness from capability-complete substrate toward a daily usable AI harness with evidence from real work."
    );

    const postDogfoodReadinessState = withTaskStatus(postFollowUpToolState, "end-to-end-harness-dogfood", "done");
    const ergonomicsTask = planNextSelfBuildTask(postDogfoodReadinessState);

    expect(ergonomicsTask?.id).toBe("operator-ergonomics-polish");
    expect(ergonomicsTask?.thereContribution).toBe("Turns verified harness capability into smoother daily operator experience.");

    const postErgonomicsState = withTaskStatus(postDogfoodReadinessState, "operator-ergonomics-polish", "done");
    const apiSessionTask = planNextSelfBuildTask(postErgonomicsState);

    expect(apiSessionTask?.id).toBe("api-resumable-sessions");
    expect(apiSessionTask?.thereContribution).toBe("Turns runtime session persistence into practical API-side multi-step operator workflows.");

    const postApiSessionState = withTaskStatus(postErgonomicsState, "api-resumable-sessions", "done");
    const apiSessionEventsTask = planNextSelfBuildTask(postApiSessionState);

    expect(apiSessionEventsTask?.id).toBe("api-session-events");
    expect(apiSessionEventsTask?.thereContribution).toBe(
      "Gives operators practical continuity evidence for API sessions without exposing raw runtime internals."
    );

    const postApiSessionEventsState = withTaskStatus(postApiSessionState, "api-session-events", "done");
    const sessionInspectionTask = planNextSelfBuildTask(postApiSessionEventsState);

    expect(sessionInspectionTask?.id).toBe("session-inspection-helper");
    expect(sessionInspectionTask?.thereContribution).toBe(
      "Turns API-side continuity data into a practical daily workflow for inspecting and resuming harness sessions."
    );

    const postSessionInspectionState = withTaskStatus(postApiSessionEventsState, "session-inspection-helper", "done");
    const persistedTimelineTask = planNextSelfBuildTask(postSessionInspectionState);

    expect(persistedTimelineTask?.id).toBe("persisted-session-timeline-inspection");
    expect(persistedTimelineTask?.thereContribution).toBe(
      "Closes the next continuity gap by making session inspection durable instead of API-process-local only."
    );

    const postPersistedTimelineState = withTaskStatus(postSessionInspectionState, "persisted-session-timeline-inspection", "done");
    const sessionListingTask = planNextSelfBuildTask(postPersistedTimelineState);

    expect(sessionListingTask?.id).toBe("session-listing-helper");
    expect(sessionListingTask?.thereContribution).toBe(
      "Makes continuity workflows discoverable by helping operators find the right session before inspecting or resuming it."
    );

    const postSessionListingState = withTaskStatus(postPersistedTimelineState, "session-listing-helper", "done");
    const sessionContinuationTask = planNextSelfBuildTask(postSessionListingState);

    expect(sessionContinuationTask?.id).toBe("session-continuation-helper");
    expect(sessionContinuationTask?.thereContribution).toBe(
      "Closes the workflow gap between session discovery and safe continuation of long-running harness work."
    );

    const postSessionContinuationState = withTaskStatus(postSessionListingState, "session-continuation-helper", "done");
    const sessionContinuationDogfoodTask = planNextSelfBuildTask(postSessionContinuationState);

    expect(sessionContinuationDogfoodTask?.id).toBe("session-continuation-dogfood");
    expect(sessionContinuationDogfoodTask?.thereContribution).toBe(
      "Proves the newly connected harness session continuity helpers work together as a daily operator recovery workflow."
    );

    const postSessionContinuationDogfoodState = withTaskStatus(postSessionContinuationState, "session-continuation-dogfood", "done");
    const operatorContinuityTask = planNextSelfBuildTask(postSessionContinuationDogfoodState);

    expect(operatorContinuityTask?.id).toBe("operator-continuity-playbook");
    expect(operatorContinuityTask?.thereContribution).toBe(
      "Turns proven harness session recovery evidence into daily operator guidance for safe continuation."
    );

    const postOperatorContinuityState = withTaskStatus(postSessionContinuationDogfoodState, "operator-continuity-playbook", "done");
    const apiOperatorStartupTask = planNextSelfBuildTask(postOperatorContinuityState);

    expect(apiOperatorStartupTask?.id).toBe("api-operator-startup-playbook");
    expect(apiOperatorStartupTask?.thereContribution).toBe(
      "Gives operators a reliable harness API entry path before running session recovery workflows."
    );

    const postApiOperatorStartupState = withTaskStatus(postOperatorContinuityState, "api-operator-startup-playbook", "done");
    const apiStartupDogfoodTask = planNextSelfBuildTask(postApiOperatorStartupState);

    expect(apiStartupDogfoodTask?.id).toBe("api-startup-dogfood");
    expect(apiStartupDogfoodTask?.thereContribution).toBe(
      "Proves the startup guidance works as a daily operator entry path before session recovery commands."
    );
  });
});

describe("runSelfBuildLoop", () => {
  it("should execute bounded iterations and report the next task", async () => {
    const report = await runSelfBuildLoop({
      state: createSelfBuildState(),
      maxIterations: 1,
      executeTask: createDryRunSelfBuildExecutor()
    });

    expect(report.stopReason).toBe("max_iterations");
    expect(report.completedTaskIds).toEqual(["capture-operating-contract"]);
    expect(report.nextTask?.id).toBe("core-result-contracts");
    expect(report.iterations).toHaveLength(1);
  });

  it("should stop when an executor reports a blocker", async () => {
    const report = await runSelfBuildLoop({
      state: createSelfBuildState(),
      maxIterations: 3,
      executeTask: (task) => ({
        status: "blocked",
        summary: `Blocked on ${task.id}.`,
        evidence: ["missing prerequisite"]
      })
    });

    expect(report.stopReason).toBe("blocked");
    expect(report.blockedTaskId).toBe("capture-operating-contract");
    expect(report.completedTaskIds).toEqual([]);
  });
});

function withTaskStatus(state: SelfBuildState, taskId: string, status: SelfBuildState["tasks"][number]["status"]): SelfBuildState {
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status } : task))
  };
}
