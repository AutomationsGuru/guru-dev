export type SelfBuildTaskStatus = "ready" | "in_progress" | "blocked" | "done" | "skipped";
export type SelfBuildTaskPriority = "now" | "next" | "later";
export type SelfBuildActionStatus = "completed" | "blocked" | "skipped";
export type SelfBuildStopReason = "completed" | "max_iterations" | "blocked" | "no_ready_tasks";

export interface SelfBuildTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly thereContribution: string;
  readonly priority: SelfBuildTaskPriority;
  readonly status: SelfBuildTaskStatus;
  readonly dependsOn: readonly string[];
}

export interface SelfBuildState {
  readonly objective: string;
  readonly here: string;
  readonly there: string;
  readonly referenceRuntime: string;
  readonly constraints: readonly string[];
  readonly tasks: readonly SelfBuildTask[];
}

export interface SelfBuildActionResult {
  readonly status: SelfBuildActionStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface SelfBuildIteration {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly result: SelfBuildActionResult;
}

export interface SelfBuildLoopReport {
  readonly objective: string;
  readonly stopReason: SelfBuildStopReason;
  readonly iterations: readonly SelfBuildIteration[];
  readonly completedTaskIds: readonly string[];
  readonly blockedTaskId?: string;
  readonly nextTask?: SelfBuildTask;
  readonly remainingTaskIds: readonly string[];
}

export interface SelfBuildLoopOptions {
  readonly state: SelfBuildState;
  readonly maxIterations?: number;
  readonly executeTask: (task: SelfBuildTask, state: SelfBuildState) => Promise<SelfBuildActionResult> | SelfBuildActionResult;
}

const priorityOrder: Record<SelfBuildTaskPriority, number> = {
  now: 0,
  next: 1,
  later: 2
};

export function createSelfBuildState(): SelfBuildState {
  return {
    objective:
      "Build GuruHarness into an independent agent harness with self-building capability; use the self-build loop only as a bounded construction/dogfood mechanism.",
    here:
      "GuruHarness is a validated harness substrate with governance, config loading, typed tool registry, repo/AGENTS context, validation and review gates, git/PR automation, Supabase operational memory, runtime skill loading, maintenance audit, a resumable session runtime nucleus, planner runtime, self-build executor, OpenAI-compatible model adapter, operational-store-backed session persistence, run CLI lifecycle, API/TUI surfaces, strict runtime hardening, provider fallback playbooks, long-running observability beacons, operator recovery workflows, first-class bounded file/shell execution tools, GitHub PR review/comment/status helpers, broader operational runtime tools, API-side resumable tool sessions, API session event reads, CLI/API session inspection, persisted timeline inspection after API restarts, session listing, guided session continuation suggestions, bounded list-inspect-continue dogfood proof, concise operator continuity playbook guidance, API startup guidance, and verified end-to-end dogfood coverage across runtime, CLI, API, persistence, and recovery paths. It is not yet fully polished for daily use because the startup playbook still needs a bounded dogfood proof from API launch through health evidence into recovery-command readiness.",
    there:
      "GuruHarness is a working independent agent harness with self-building capability: a harness runtime that can start and resume agent sessions, assemble context from repo/AGENTS/skills/memory/config, dispatch typed tools safely, enforce review and capture policy, expose practical CLI/API/TUI surfaces, persist operational memory, and support build-time self-improvement without mistaking the self-build loop for the product.",
    referenceRuntime: "a reference agent runtime",
    constraints: [
      "Every new task starts by reading HERE and THERE and proving the task moves GuruHarness toward THERE.",
      "Keep self-build loops bounded; never treat the loop itself as the finished product.",
      "Load AGENTS.md and relevant skills before repository mutation.",
      "Validate locally and run review before GREEN handoff.",
      "Commit, push, and open PRs automatically after validation passes.",
      "Never store Supabase credentials, raw environment values, or runtime .temp state in git."
    ],
    tasks: [
      createTask(
        "capture-operating-contract",
        "Capture operating contract",
        "Mirror the binding reference work contract into GuruHarness docs and decisions.",
        "Defines the initial harness policy and operating contract needed for an independent agent harness.",
        "now"
      ),
      createTask(
        "core-result-contracts",
        "Define core result contracts",
        "Create traffic-light verdicts, normalized tool results, and done-packet contracts.",
        "Provides harness-native result and done-packet contracts for session and tool outcomes.",
        "now",
        ["capture-operating-contract"]
      ),
      createTask(
        "supabase-operational-store",
        "Create Supabase operational store",
        "Track projects, state, decisions, backlog, implementations, configurations, and endpoints in Supabase.",
        "Creates durable harness memory tables for project state, decisions, backlog, and runtime configuration.",
        "now",
        ["capture-operating-contract"]
      ),
      createTask(
        "self-build-loop",
        "Build self-build loop",
        "Select the next parity task, execute a bounded iteration, validate, review, and emit a done packet.",
        "Adds a bounded build-time mechanism for constructing the harness while preserving validation and review gates.",
        "now",
        ["core-result-contracts", "supabase-operational-store"]
      ),
      createTask(
        "config-loader",
        "Add config/profile loader",
        "Load runtime profile, approval policy, validation commands, and skill directories from disk.",
        "Adds runtime profile and policy configuration needed by a usable independent agent harness.",
        "next",
        ["self-build-loop"]
      ),
      createTask(
        "tool-registry",
        "Add typed tool registry",
        "Register schema-first tools and normalize execution observations.",
        "Creates the schema-first harness action space for safe typed tool dispatch.",
        "next",
        ["config-loader"]
      ),
      createTask(
        "repo-context-layer",
        "Add repo and AGENTS-context layer",
        "Discover git repo state and walk AGENTS.md contracts root-to-leaf.",
        "Gives the harness repo-aware context and binding instruction discovery like a reference agent runtime.",
        "next",
        ["tool-registry"]
      ),
      createTask(
        "review-gates",
        "Add validation and review gates",
        "Run configured validation, review, and safety checks before done packets or PRs.",
        "Adds harness policy enforcement for validation and review gates.",
        "next",
        ["repo-context-layer"]
      ),
      createTask(
        "git-pr-automation",
        "Add git and PR automation",
        "Commit, push, open PRs, and report upstream merge readiness through protected GitHub flows.",
        "Adds GitHub and PR workflow primitives required for repo-working harness sessions.",
        "later",
        ["review-gates"]
      ),
      createTask(
        "maintenance-loop",
        "Add maintenance loop",
        "Periodically audit docs, skills, configs, dependencies, and repo hygiene for drift.",
        "Adds harness maintenance checks for repo health, config drift, review policy, and skill catalog readiness.",
        "later",
        ["git-pr-automation"]
      ),
      createTask(
        "supabase-runtime-adapter",
        "Add Supabase runtime adapter",
        "Read and write operational project state, decisions, backlog, implementations, and blockers at runtime.",
        "Connects runtime code to Supabase-backed harness memory without committing credentials.",
        "next",
        ["maintenance-loop"]
      ),
      createTask(
        "skill-loader",
        "Add runtime skill loader",
        "Discover and load file-based skills for task-specific operating instructions.",
        "Lets the harness load task-specific skill instructions into future sessions.",
        "later",
        ["maintenance-loop"]
      ),
      createTask(
        "direction-gate",
        "Add HERE/THERE direction gate",
        "Require every new task to state current HERE, target THERE, and the task's contribution toward the independent agent harness target before implementation starts.",
        "Prevents roadmap drift by forcing each task to prove it moves the harness toward an independent agent harness with self-building capability.",
        "later",
        ["supabase-runtime-adapter", "skill-loader"]
      ),
      createTask(
        "harness-runtime-nucleus",
        "Add harness runtime nucleus",
        "Start the first real GuruHarness session runtime that assembles HERE/THERE, config, skills, repo context, memory, and tools for a task.",
        "Introduces the actual harness runtime session nucleus that turns the existing primitives into an independent agent harness foundation.",
        "later",
        ["direction-gate"]
      ),
      createTask(
        "planner-runtime",
        "Add planner runtime",
        "Plan and coordinate model-backed task execution across the registered action space.",
        "Adds model-backed planning and tool orchestration for practical harness sessions.",
        "later",
        ["harness-runtime-nucleus"]
      ),
      createTask(
        "self-build-executor",
        "Add self-build executor dogfood mode",
        "Execute bounded self-build tasks through the harness runtime, repo, validation, review, git/PR, done-packet, and Supabase tools.",
        "Dogfoods the harness runtime for construction work while keeping self-build as an internal mode, not the product target.",
        "later",
        ["harness-runtime-nucleus", "planner-runtime"]
      ),
      createTask(
        "model-adapter",
        "Add production model adapter",
        "Connect planner runtime to a configured real model provider while keeping credentials outside git.",
        "Turns injected planner contracts into actual model-backed harness execution.",
        "later",
        ["self-build-executor"]
      ),
      createTask(
        "session-persistence",
        "Add durable session persistence",
        "Persist sessions, planner runs, tool observations, blockers, and done packets through the operational store.",
        "Lets GuruHarness resume and audit harness sessions instead of relying on in-memory runtime state.",
        "later",
        ["self-build-executor", "supabase-runtime-adapter"]
      ),
      createTask(
        "run-command-lifecycle",
        "Add run command lifecycle",
        "Expose a practical CLI lifecycle command that starts a session, plans, executes, validates, reviews, records, and reports.",
        "Creates the first daily-usable GuruHarness command for end-to-end agent work.",
        "later",
        ["self-build-executor", "model-adapter", "session-persistence"]
      ),
      createTask(
        "api-tui-surfaces",
        "Add API and TUI surfaces",
        "Expose session and run control through API/TUI surfaces after the CLI lifecycle is stable.",
        "Moves GuruHarness from library/CLI primitives toward practical interactive harness usage.",
        "later",
        ["run-command-lifecycle"]
      ),
      createTask(
        "runtime-hardening",
        "Harden runtime safety and recovery",
        "Add dirty-state protection, secret/risky-path guards, resume/retry semantics, and provider fallback handling.",
        "Improves reliability and safety for long-running autonomous harness work.",
        "later",
        ["run-command-lifecycle"]
      ),
      createTask(
        "provider-fallback-playbook",
        "Add provider fallback playbook",
        "Extend the hardening fallback chain with explicit rotation, alarms, recovery narrative, and structured observability for long-running runs.",
        "Turns the basic fallback mechanism into a trustworthy long-running autonomous harness capability.",
        "later",
        ["runtime-hardening"]
      ),
      createTask(
        "long-running-observability",
        "Add long-running observability",
        "Add run timeline snapshots, progress beacons, resume breadcrumbs, and operator recovery summaries for multi-hour harness sessions.",
        "Makes GuruHarness safer to dogfood on long autonomous runs by exposing continuity and recovery evidence.",
        "later",
        ["provider-fallback-playbook"]
      ),
      createTask(
        "operator-recovery-workflows",
        "Add operator recovery workflows",
        "Add pause, resume, abort, retry-from-checkpoint, and blocked-run continuation workflows over persisted session timelines.",
        "Turns observability evidence into practical operator controls for recovering autonomous harness runs.",
        "later",
        ["long-running-observability"]
      ),
      createTask(
        "tool-execution-expansion",
        "Expand runtime tool execution",
        "Add first-class file editing and shell execution with policy-aware guardrails.",
        "Broadens GuruHarness from planning/recovery substrate into a practical AI harness that can perform real bounded file and command work.",
        "later",
        ["operator-recovery-workflows"]
      ),
      createTask(
        "github-and-operational-tool-expansion",
        "Add GitHub and operational runtime tools",
        "Add GitHub review/comment helpers and broader operational tools after the bounded file/shell guard pattern lands.",
        "Completes the practical runtime tool breadth needed for review collaboration and operational state updates.",
        "later",
        ["tool-execution-expansion"]
      ),
      createTask(
        "end-to-end-harness-dogfood",
        "Dogfood end-to-end harness readiness",
        "Run GuruHarness through representative bounded coding, review, recovery, GitHub, and operational-memory workflows to expose usability gaps.",
        "Moves GuruHarness from capability-complete substrate toward a daily usable AI harness with evidence from real work.",
        "later",
        ["github-and-operational-tool-expansion"]
      ),
      createTask(
        "operator-ergonomics-polish",
        "Polish daily operator ergonomics",
        "Improve cross-shell path handling, focused dogfood filters, and CLI/API affordances discovered during end-to-end dogfood.",
        "Turns verified harness capability into smoother daily operator experience.",
        "later",
        ["end-to-end-harness-dogfood"]
      ),
      createTask(
        "api-resumable-sessions",
        "Add API resumable session tool runs",
        "Expose minimal API session status and allow /tool-run to target an existing persisted session.",
        "Turns runtime session persistence into practical API-side multi-step operator workflows.",
        "later",
        ["operator-ergonomics-polish"]
      ),
      createTask(
        "api-session-events",
        "Add API session event reads",
        "Expose a bounded read-only API endpoint for compact session timeline and event summaries.",
        "Gives operators practical continuity evidence for API sessions without exposing raw runtime internals.",
        "later",
        ["api-resumable-sessions"]
      ),
      createTask(
        "session-inspection-helper",
        "Add CLI/API session inspection helper",
        "Add a small operator helper that summarizes session status and timeline evidence from CLI/API surfaces without exposing raw runtime internals.",
        "Turns API-side continuity data into a practical daily workflow for inspecting and resuming harness sessions.",
        "later",
        ["api-session-events"]
      ),
      createTask(
        "persisted-session-timeline-inspection",
        "Add persisted session timeline inspection",
        "Let operators inspect persisted session timeline evidence after API process restarts without exposing raw runtime internals.",
        "Closes the next continuity gap by making session inspection durable instead of API-process-local only.",
        "later",
        ["session-inspection-helper"]
      ),
      createTask(
        "session-listing-helper",
        "Add session listing helper",
        "Add a bounded operator helper for listing recent persisted sessions with compact latest-status summaries.",
        "Makes continuity workflows discoverable by helping operators find the right session before inspecting or resuming it.",
        "later",
        ["persisted-session-timeline-inspection"]
      ),
      createTask(
        "session-continuation-helper",
        "Add guided session continuation helper",
        "Add a bounded operator helper that turns a listed or inspected session id into explicit safe resume/run commands.",
        "Closes the workflow gap between session discovery and safe continuation of long-running harness work.",
        "later",
        ["session-listing-helper"]
      ),
      createTask(
        "session-continuation-dogfood",
        "Dogfood session continuation workflow",
        "Run bounded list-inspect-continue workflow proof for persisted sessions and capture operator continuity evidence.",
        "Proves the newly connected harness session continuity helpers work together as a daily operator recovery workflow.",
        "later",
        ["session-continuation-helper"]
      ),
      createTask(
        "operator-continuity-playbook",
        "Add operator continuity playbook",
        "Document the proven list-inspect-continue recovery loop as a concise daily operator playbook.",
        "Turns proven harness session recovery evidence into daily operator guidance for safe continuation.",
        "later",
        ["session-continuation-dogfood"]
      ),
      createTask(
        "api-operator-startup-playbook",
        "Add API operator startup playbook",
        "Document how to start the GuruHarness API, verify health, and capture the base URL before using continuity helpers.",
        "Gives operators a reliable harness API entry path before running session recovery workflows.",
        "later",
        ["operator-continuity-playbook"]
      ),
      createTask(
        "api-startup-dogfood",
        "Dogfood API startup playbook",
        "Run the documented terminal-to-health-to-recovery-command flow against a bounded local API instance and capture evidence.",
        "Proves the startup guidance works as a daily operator entry path before session recovery commands.",
        "later",
        ["api-operator-startup-playbook"]
      )
    ]
  };
}

export function applySelfBuildProgress(state: SelfBuildState, completedTaskIds: readonly string[]): SelfBuildState {
  const completed = new Set(completedTaskIds);

  return {
    ...state,
    tasks: state.tasks.map((task) => (completed.has(task.id) ? { ...task, status: "done" } : task))
  };
}

export function planNextSelfBuildTask(state: SelfBuildState): SelfBuildTask | undefined {
  const completedTaskIds = new Set(state.tasks.filter((task) => task.status === "done").map((task) => task.id));

  return state.tasks
    .filter((task) => task.status === "ready")
    .filter((task) => task.dependsOn.every((dependency) => completedTaskIds.has(dependency)))
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.id.localeCompare(b.id))[0];
}

export async function runSelfBuildLoop(options: SelfBuildLoopOptions): Promise<SelfBuildLoopReport> {
  const maxIterations = options.maxIterations ?? 1;
  let state = cloneState(options.state);
  const iterations: SelfBuildIteration[] = [];

  for (let index = 0; index < maxIterations; index += 1) {
    const nextTask = planNextSelfBuildTask(state);

    if (!nextTask) {
      return buildReport(state, iterations, "no_ready_tasks");
    }

    state = updateTaskStatus(state, nextTask.id, "in_progress");
    const result = await options.executeTask(nextTask, state);
    iterations.push({ taskId: nextTask.id, taskTitle: nextTask.title, result });

    if (result.status === "blocked") {
      state = updateTaskStatus(state, nextTask.id, "blocked");
      return buildReport(state, iterations, "blocked", nextTask.id);
    }

    state = updateTaskStatus(state, nextTask.id, result.status === "completed" ? "done" : "skipped");
  }

  const stopReason = planNextSelfBuildTask(state) ? "max_iterations" : "completed";
  return buildReport(state, iterations, stopReason);
}

export function createDryRunSelfBuildExecutor(): SelfBuildLoopOptions["executeTask"] {
  return (task) => ({
    status: "completed",
    summary: `Dry-run completed task selection for ${task.id}.`,
    evidence: [task.title]
  });
}

function createTask(
  id: string,
  title: string,
  description: string,
  thereContribution: string,
  priority: SelfBuildTaskPriority,
  dependsOn: readonly string[] = []
): SelfBuildTask {
  return {
    id,
    title,
    description,
    thereContribution,
    priority,
    status: "ready",
    dependsOn
  };
}

function cloneState(state: SelfBuildState): SelfBuildState {
  return {
    ...state,
    constraints: [...state.constraints],
    tasks: state.tasks.map((task) => ({ ...task, dependsOn: [...task.dependsOn] }))
  };
}

function updateTaskStatus(state: SelfBuildState, taskId: string, status: SelfBuildTaskStatus): SelfBuildState {
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status } : task))
  };
}

function buildReport(
  state: SelfBuildState,
  iterations: readonly SelfBuildIteration[],
  stopReason: SelfBuildStopReason,
  blockedTaskId?: string
): SelfBuildLoopReport {
  const nextTask = planNextSelfBuildTask(state);

  return {
    objective: state.objective,
    stopReason,
    iterations,
    completedTaskIds: state.tasks.filter((task) => task.status === "done").map((task) => task.id),
    ...(blockedTaskId ? { blockedTaskId } : {}),
    ...(nextTask ? { nextTask } : {}),
    remainingTaskIds: state.tasks.filter((task) => task.status !== "done").map((task) => task.id)
  };
}
