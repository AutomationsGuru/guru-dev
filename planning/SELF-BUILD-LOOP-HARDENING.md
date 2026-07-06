CONFIRMED 23 | PLAUSIBLE 3 | REFUTED 5

### [1] HIGH — src/selfbuild/gitDelivery.ts (correctness)
TITLE: git commit exit code ignored in makeGatedGitDelivery → false GREEN ship when no commit was created
FIX: Capture and inspect the commit result before pushing, treating a genuine failure as RED while allowing the benign "nothing to commit" no-op to be surfaced honestly (e.g. YELLOW), rather than pushing and claiming GREEN. Minimal change at lines 58-63:

```ts
const commit = deps.runGit(["commit", "-am", deps.commitMessage ?? "chore: self-build delivery"], deps.cwd);
if (commit.exitCode !== 0) {
  const out = `${commit.stdout}\n${commit.stderr}`;
  // A clean tree / no staged change is not a real error, but it is NOT a GREEN ship.
  if (/nothing to commit|no changes added|nothing added to commit/i

### [2] LOW — src/selfbuild/runDevCycle.ts (correctness)
TITLE: "No ready task" returns terminal=done with verdict=GREEN while the only recorded stage is RED
FIX: Make the overall verdict honor RED stages on the non-blocked path. Replace the computation at runDevCycle.ts:332-336 with one that checks for any RED stage before falling through to GREEN:

  const overall: StageVerdict = blocked || stages.some((s) => s.verdict === "RED")
    ? "RED"
    : stages.some((s) => s.verdict === "YELLOW")
      ? "YELLOW"
      : "GREEN";

This yields verdict="RED", terminal="done" for the empty-queue case — internally consistent (a cycle whose only stage is RED no longer reports GREEN). If instead "no ready task" is meant to be a genuine success, the alternative min

### [3] LOW — src/selfbuild/runDevCycle.ts (correctness)
TITLE: Token budget never drawn down on the real BUILD/DEBUG path, so the token ceiling is inert
FIX: Make the token count real end-to-end: (1) add a `tokens` (consumed-token) field to SelfBuildExecutorReport and populate it in the executor from its observability/usage data; (2) in runDevCycle's BUILD default and defaultRepair, return `tokens: executorReport.tokens` so budget.recordTokens fires on every model turn. If threading a real count is out of scope, the minimal honest change is to drop the "token budget" from the documented independent-halting-condition claims (class doc at runDevCycle.ts:32-42 and devCycle.ts) so it isn't presented as a live bound it never enforces.

### [4] HIGH — src/executor/selfBuildExecutor.ts (spend-safety)
TITLE: Executor git push/PR automation bypasses the mandate policy (direct runGitPrAutomation call, not runtime.executeTool)
FIX: Route the executor-internal git delivery through the mandate policy before executing it, mirroring makeGatedGitDelivery. In runSelfBuildExecutorWithRuntime, right before the runGitPrAutomation call (selfBuildExecutor.ts:359) when options.git?.enabled && dryRun===false, evaluate the delivery through options.mandatePolicy — e.g. `const decision = options.mandatePolicy?.("git.pr.run", { repoRoot, branchName, ... }, session.repo?.repoRoot ?? cwd);` and if `decision && decision.outcome !== "allow"`, take the existing git-pr-approval blocked branch (recordProgressBeacon + buildBlockedReport) instead

### [5] MEDIUM — src/executor/selfBuildExecutor.ts (spend-safety)
TITLE: `run` command executes live git push + PR gated only by a default-true config flag, with no mandate/ledger evaluation
FIX: Make the live-git path fail-closed and audited independently of the flag default: (1) In selfBuildExecutor.ts around line 335, invert the default so live git requires a POSITIVE opt-in that is not on by default — e.g. block when `options.git.dryRun === false` unless BOTH autoCommitPushPr is true AND a mandatePolicy/approval token was explicitly supplied to this run; and change the shipped guruharness.config.json `autoCommitPushPr` to false so the default posture blocks live push. (2) Route runGitPrAutomation's git-push and gh-pr-create steps through a mandate check (evaluateToolMandate for `gi

### [6] MEDIUM — src/selfbuild/gitDelivery.ts (spend-safety)
TITLE: Mandate-gated git delivery (makeGatedGitDelivery) is orphaned; the live push path the product actually uses bypasses the spend/deploy gate
FIX: Close the actual hole on the executor path AND wire the gated delivery into the dev cycle. Minimal, highest-value change: route runGitPrAutomation's live push through the mandate policy. Thread the MandatePolicyFn into runSelfBuildExecutor's git block (selfBuildExecutor.ts:353-373) / prAutomation, and before executing the non-dry-run git-push/gh-pr-create steps, evaluate `policy("bash", {command: "git push ..."}, repoRoot)` — if the outcome is not "allow", block/degrade instead of pushing (mirroring gitDelivery.ts:46-56). Additionally wire makeGatedGitDelivery into `self-build-run` by passing 

### [7] HIGH — src/selfbuild/askModelAdapter.ts (budget-termination)
TITLE: REVIEW stage model call has no timeout — a blackholed connection hangs the dev cycle forever
FIX: Give the REVIEW model call a bounded per-request timeout. The timeout plumbing already exists and is honored end-to-end (agentTurn.ts:744/1035), so the minimal fix is at the construction site — pass a retry config carrying provider.timeoutMs. In cli.ts:269 change the options object to include a retry config, e.g.:

  makeAskModelFromRoute(routeFromPlannerConfig(plannerModel), {
    env: process.env,
    retry: { ...DEFAULT_RETRY_CONFIG, provider: { ...DEFAULT_RETRY_CONFIG.provider, timeoutMs: 120_000 } }
  })

(or plumb a default timeoutMs into makeAskModelFromRoute itself so every native-crit

### [8] HIGH — src/review/gates.ts (budget-termination)
TITLE: TEST stage gate subprocesses run with no timeout — a hanging test/build command stalls the dev-cycle loop forever
FIX: The kill/timeout machinery already fully exists in executeCommand (SIGTERM/taskkill + SIGKILL escalation, gates.ts:181-214) — only the value is never populated on this path. Thread a default timeout in: (a) add an optional `timeoutMs` to CommandGate (gates.ts:50-57) and pass it through executeGateCommand — `executor(gate.command, { ...(cwd ? { cwd } : {}), gate, ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}) })` at gates.ts:304; and (b) set a sane per-gate default (e.g. 10 minutes) when building discovered gates in discoverGates.ts / toValidationGate so `npm run test`, 

### [9] MEDIUM — src/selfbuild/runDevCycle.ts (budget-termination)
TITLE: DevCycleBudget wall-clock is only polled between stages, not enforced during an in-flight stage — a hung TEST subprocess or REVIEW model call stalls the loop past wallClockMs
FIX: Derive a wall-clock deadline from config.wallClockMs and enforce it DURING each stage, not just between stages. Minimal option: at the loop level, race each `runners[stage]()` against a deadline promise (remaining = wallClockMs - elapsed) so a stalled await is interrupted and recorded as `budget exhausted: wall-clock`. Better: thread an AbortController tied to the wall-clock deadline into the gate/model paths — set context.signal (and a per-gate timeoutMs) in executeGateCommand (gates.ts:304), and pass a signal into askModel — so the TEST subprocess is actually killed (executeCommand already h

### [10] HIGH — src/selfbuild/gitDelivery.ts (wiring-gaps)
TITLE: gitDelivery (makeGatedGitDelivery) is built but never composed — SHIP can never actually push
FIX: Wire the gated delivery into the default SHIP so it is not dependent on an external caller. In runDevCycle.ts's default `ship` runner (lines 269-284), when git is present construct `gitDelivery: makeGatedGitDelivery({ cwd, policy, payload, runGit })` using the cycle's own mandate `policy` (already in scope), the `cwd`, the change-record `payload` it already builds at lines 276-280, and a real git runner — and pass it as shipDeps.gitDelivery to runShipStage (still allowing input.shipDeps/input.ship to override for tests). This closes the seam without changing the spine: SHIP then actually route

### [11] HIGH — D:\.projects\guruharness\main\src\selfbuild\runDevCycle.ts (wiring-gaps)
TITLE: LEARN default runner hardcodes YELLOW, making a clean dev cycle structurally unable to report GREEN
FIX: In src/selfbuild/runDevCycle.ts, change the default LEARN runner's return at line 295 from the hardcoded `verdict: "YELLOW"` to the already-computed `softVerdict`:

  return { verdict: softVerdict, evidence: `LEARN: ${learnedFact.fact} (${learnedFact.confidence})` };

Because `softVerdict` (line 290) is derived from the stages recorded before LEARN's own outcome is pushed, a fully clean run yields GREEN and the overall verdict at lines 324-328 becomes GREEN; any prior YELLOW still propagates as YELLOW. Optionally add an assertion to the tests/selfbuild/runDevCycle.test.ts:341 clean-success tes

### [12] MEDIUM — src/cli.ts (wiring-gaps)
TITLE: CLI self-build-run never persists LEARN output — the LEARN→SELECT feedback arc does not close across invocations
FIX: Add a persistent task-outcome store on the CLI self-build-run path, mirroring the existing .guru/ conventions. Minimally: (a) create a small store module (e.g. src/selfbuild/outcomeStore.ts) that reads/writes `<cwd>/.guru/task-outcomes.json` holding the recentBlockers and completed id sets; (b) in cli.ts:271-281, load that store into a TaskOutcomeHistory and pass `recordFact` to runDevCycle so each cycle's LearnedFact updates the store (outcome==="blocked" → add to recentBlockers; outcome==="shipped" → add to completed and clear from recentBlockers). Then, on repeated runs of the same task, de

### [13] MEDIUM — src/selfbuild/runDevCycleLoop.ts (wiring-gaps)
TITLE: Multi-cycle driver runDevCycleLoop is built and tested but has no CLI/API/library call site
FIX: Wire runDevCycleLoop into the self-build-run command: add a `--loop` flag (or a `self-build-loop` subcommand) that, instead of the single runDevCycle at src/cli.ts:271, loads the ready task set and calls runDevCycleLoop({ tasks, baseInput: { ...(askModel ? { askModel } : {}), smoke: makeSmokeDeps({ cwd }), executorOptions }, maxCycles }), then prints the DevCycleLoopReport and sets process.exitCode from blocked.length. This reuses the exact baseInput already assembled at lines 271-281 (executorOptions built per chosen.id inside the loop). Also add `export * from "./selfbuild/runDevCycleLoop.js

### [14] LOW — src/selfbuild/runDevCycle.ts:276 (wiring-gaps)
TITLE: SHIP change-record never populates overallVerdict — schema field always defaults to YELLOW
FIX: Applied the minimal fix in the default SHIP runner (runDevCycle.ts): compute a roll-up from the stages recorded so far (any RED → RED, any YELLOW → YELLOW, else GREEN) and pass it as `overallVerdict` in the payload, instead of letting the schema default it to YELLOW. This mirrors the post-loop overall-verdict logic and makes the persisted record reflect real cycle state.

### [15] MEDIUM — src/cli.ts (wiring-gaps)
TITLE: --dry-run plan reports SMOKE/REVIEW "not wired" while --run actually wires them
FIX: In the cli.ts --dry-run branch, compute the same wiring signals the --run path uses and pass them to buildDevCyclePlan: (1) hasSmoke: true (the run path wires makeSmokeDeps unconditionally); (2) hasReviewer: load the config and check plannerModel !== undefined && the apiKeyEnvVar is present — the exact keyPresent test at cli.ts:268; (3) hasGitDelivery: detect git presence the same way SHIP does. Concretely, load devCycleConfig before the dry-run branch (or inside it) and pass buildDevCyclePlan({ cwd, hasSmoke: true, hasReviewer: keyPresent, hasGitDelivery: <git detected>, ...taskId }). This ma

### [16] LOW — D:\.projects\guruharness\main\src\cli.ts (wiring-gaps)
TITLE: SMOKE self-call is never wired from the CLI, so SMOKE ships as a capability-smoke half-run
FIX: In cli.ts (near line 271-273, the `--run` path), construct a bounded self-call closure that starts an AgentSession against `cwd` and runs one real `driveTurn`, then pass it plus a timeout into makeSmokeDeps: `smoke: makeSmokeDeps({ cwd, selfCall: (signal) => runOneBoundedTurn(cwd, signal), timeoutMs: 60_000 })`. `runOneBoundedTurn` should honor the AbortSignal and reject on driveTurn error/timeout so runSmokeStage maps a broken turn to selfCall:"error"/"timeout" → SMOKE RED. Keep the self-call skippable in tests (the `input.selfCall ? ...` guard already allows that), so only the production CLI

### [17] MEDIUM — src/selfbuild/runDevCycle.ts (test-holes)
TITLE: DevCycleBudget spend gate (canSpend/recordSpend) is a dead seam in runDevCycle with no covering test
FIX: Add an end-to-end runDevCycle test that makes the intended contract explicit, plus (recommended) close the seam so the doc/test match reality. Minimal test-only option: add a test asserting the CURRENT reality so the dead seam is documented as intentional — drive a cycle and assert that runDevCycle never touches budget.canSpend/recordSpend and that spend enforcement is delegated to the mandate policy (spy on a DevCycleBudget instance's canSpend, run a full cycle, expect it uncalled), so any future author wiring a paid stage to the budget is forced to update the test. Stronger fix (closes the r

### [18] MEDIUM — src/selfbuild/runDevCycle.ts (test-holes)
TITLE: Ledger integration inside runDevCycle (report.ledger via ledgerRecordingPolicy wrap) is never asserted
FIX: Add a runDevCycle test that (a) provides `ledger: createApprovalLedger()` AND (b) uses a fake executor that actually invokes the threaded policy with a gated tool, then asserts the report captures it. Minimal example in tests/selfbuild/runDevCycle.test.ts:

it("threads the ledger-recording policy into the executor and surfaces recorded decisions on report.ledger", async () => {
  const ledger = createApprovalLedger();
  const spyExec: SelfBuildExecutorFn = async (opts) => {
    // exercise the wrapped policy the way the real executor would
    opts.mandatePolicy!("bash", { command: "terraform 

### [19] MEDIUM — src/selfbuild/runDevCycle.ts (test-holes)
TITLE: Token-budget drawdown through the loop is untested end-to-end
FIX: Add a runDevCycle test that injects token consumption through a seam and asserts the loop halts on the token ceiling. Minimal version using the `stages` seam:

  it("halts on the token budget through the loop", async () => {
    const report = await runDevCycle({
      budget: { tokenBudget: 100, maxIterations: 100 },
      stages: {
        build: async () => ({ verdict: "GREEN", evidence: "spent", tokens: 150 })
      },
      executor: async () => fakeReport({ planner: { status: "completed" } as any })
    });
    expect(report.terminal).toBe("blocked");
    expect(report.stages.at(-1)?.evi

### [20] MEDIUM — src/cli.ts (test-holes)
TITLE: Gated git delivery is wired into neither runDevCycle nor the self-build-run CLI — SHIP always degrades to local-record, and no integration test covers the wired path
FIX: Two parts. (1) Wire the delivery in the CLI so the real run path can ship: in cli.ts's self-build-run block (around line 271), import makeGatedGitDelivery and pass shipDeps.gitDelivery that binds the same fail-closed/granted mandate policy runDevCycle uses (the policy is the spend gate), a runGit executor, and the change-record payload. Alternatively, give runDevCycle a DEFAULT gitDelivery built from its own `policy` + cwd when shipDeps.gitDelivery is absent, so every production caller gets a gated push for free (and shipDeps stays the test seam). Prefer the default-in-runDevCycle approach sin

### [21] MEDIUM — src/selfbuild/parseGateFailure.ts (test-holes)
TITLE: detectKind's `\btest\b` command match forces "vitest" extraction that silently drops all failure lines for non-vitest test runners (e.g. cargo test), and no test covers it
FIX: Minimal fix is two-fold. (1) Add a regression test to tests/selfbuild/parseGateFailure.test.ts that feeds a test-named command with non-vitest failure output, e.g. parseGateFailure({name:"test", command:["cargo","test"], stdout:"test tests::adds ... FAILED\ntest result: FAILED. 2 passed; 1 failed;", stderr:"", exitCode:101}) and asserts note.failures.length > 0 (proving lines are not silently dropped). (2) Harden the code so the test passes: when kind==="vitest" but extractVitest returns [], fall back to extractGeneric(text) rather than returning an empty failures[] — e.g. `const extracted = k

### [22] LOW — src/cli.ts (test-holes)
TITLE: CLI self-build-run SMOKE never makes the promised self-call, and no test covers the assembled smoke-deps path
FIX: Add a test that pins the CLI/self-build-run SMOKE-deps behavior so the omission is either fixed or made explicit. Minimal option (document the current intentional omission): a unit test asserting `makeSmokeDeps({ cwd }).selfCall === undefined` and that runSmokeStage with those deps returns `selfCall: "skipped"` with the "no self-call wired" summary — turning the silent drop into a guarded, reviewed decision. Preferred option (fulfill the docstring): wire a real bounded driveTurn selfCall into makeSmokeDeps at cli.ts:273 and add a test asserting the CLI-assembled deps supply a selfCall that run

### [23] LOW — src/cli.ts (test-holes)
TITLE: self-build-run non-dry-run CLI path (exit-code contract, report emission, askModel gating) has no test coverage
FIX: Add a smoke.test.ts case that invokes `self-build-run` (no --dry-run) against a fast-blocking setup and asserts (a) the child process exits non-zero on a blocked terminal, and a done-path case asserting exit 0, and (b) stdout parses as a DevCycleReport. Minimal approach: run with a config whose plannerModel apiKeyEnvVar is absent (forces askModel undefined / YELLOW review) and a task/gate that blocks quickly, then use execFileSync in a try/catch to capture err.status (non-zero) and JSON.parse(err.stdout) to assert the report shape and terminal === "blocked". Optionally add a happy path with st

### PLAUSIBLE LOW — src/selfbuild/smokeStage.ts: SMOKE self-call timeout timer is never cleared → dangling timer can delay process exit
### PLAUSIBLE LOW — src/selfbuild/runDevCycleLoop.ts: runDevCycleLoop passes baseInput.tasks into inner runDevCycle, letting SELECT re-pick a different task than the loop chose
### PLAUSIBLE LOW — tests/selfbuild/discoverGates.test.ts: discoverGates polyglot precedence and Makefile spacing edge cases lack test coverage