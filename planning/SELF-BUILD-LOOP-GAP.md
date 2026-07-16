> **Note (2026-07-10):** CodeRabbit is retired from GuruHarness. Review is peer-agent + native critic panel + CI only. Historical mentions of CodeRabbit below are archival.

> **Superseded (2026-07-15, doc-control):** P7 **`runDevCycle`** and **`guru self-build-run`** ship in `src/selfbuild/`. Current spine: `SELF-BUILD-DEVELOPER-LOOP.md` (§P7). Open defects: `SELF-BUILD-LOOP-HARDENING.md`. Live doc-vs-built gaps: `../../gaps/README.md`. The body below is a pre-P7 snapshot — do not use for builder routing.

## Builder routing (v1.5.x — doc-control pass-359)

Use **`SELF-BUILD-DEVELOPER-LOOP.md`** (§Phases / P7), **`SELF-BUILD-LOOP-HARDENING.md`**, and **`../../gaps/README.md`** — not the historical sections below. Residual holes called out in DEVELOPER-LOOP “Current state” (e.g. **G8**/**G739** API **`POST /run`** → **`defaultRun`** without **`mandatePolicy`**; **G632**/**G661** TUI **`run`** in **`surfaces/tui.ts`**; **G583** CLI **`guru run`** mandate only on **`--git-live`**; G52 persistence). Gap-review pass **136** (**G755**/**G757**).

## Historical snapshot (pre-P7 — provenance only)

> Obsolete claims (no `runDevCycle`, orphaned TEST/SMOKE, etc.) are **false at 1.5.x** — gap **G163**. Kept for audit trail; do not route builders here.

## THERE (definition of done — target, partially met on dev-cycle path)

An **unattended** `runDevCycle` orchestrator that WRAPS (not replaces) `runSelfBuildExecutor` and drives one task end-to-end through **SELECT → BUILD → TEST(discovered) → SMOKE(self-call) → DEBUG(bounded repair) → SELF-REVIEW(live native panel) → SHIP(git-if-present, else on-disk change-record) → LEARN(one validated fact)**, on nothing but guru + one model key, with git/gh/CodeRabbit all absent. Every action routes through a single mandate choke point whose spend hard-edge YOLO cannot lift; the loop and all nested guru-calls are bound by an attempt cap **and** a token/$ budget with a `$0`-denies-all `SpendBudget`, VETO/STEER/BATCH/KILL levers + an escalation circuit-breaker; every mutation ships a done packet carrying validation + native-review evidence + a **persisted approval ledger that survives a restart**. Acceptance = the 8 stages run unattended + a spend verb hard-stops even in YOLO + the ledger survives restart.

## Definition of done met?

> **Status (pass-359):** **Partial** on `guru self-build-run` / `runDevCycle`; **not** on bare `guru run` / API `/run` / TUI `run`. See DEVELOPER-LOOP §P7 and `gaps/README.md`. Historical “not met” bullets below are pre-P7.

- **P7 `runDevCycle` orchestrator does not exist** _(obsolete — shipped; see DEVELOPER-LOOP)_ — no 0→7 state machine, no `guru self-build --run` surface, no whole-cycle `--dry-run` no-op preview, no per-stage 0→7 events, no cross-task resume.
- **Mandate/spend hard-edge is not injected into the executor runtime** _(pre-P7 snapshot — **`runDevCycle`** / **`guru self-build-run`** now inject fail-closed policy; still true for bare **TUI `run`**, **API `/run`**, and non-live-git **`guru run`** — **`gaps/README.md`** **G661**/**G584**/**G582**)_ — historical wording assumed zero surfaces; do not use for P7 routing.
- **No `SpendBudget` / token / wall-clock budget** bounding the loop or nested guru-calls; bounding is integer attempt/step counts only.
- **No host-allowlist net-spend classifier** and **paid-tool attach carries no `spend` verb** (`resolve_capability_gap` → `[]`).
- **No persisted approval ledger** in the done packet (`DonePacketSchema` has no ledger field) → "survives restart" unsatisfiable; executor default store is in-memory.
- **No VETO/STEER/BATCH/KILL levers or escalation circuit-breaker** for the loop.
- **DEBUG-on-red bounded repair does not exist** — no gate-output parser, no repair sub-loop, no `maxRepairAttempts`.
- **SELECT-scoring + LEARN feedback arcs are absent from the executor** — no `scoreTask`, no `listImplementations` reader on `OperationalStore`, no memory/flywheel/gap-record write-back on the executor path.
- **SHIP does not self-detect its target** — never probes `git`/`gh` presence, has no on-disk change-record fallback, so git/gh-absent goes RED-by-absence.
- **Live native reviewer is never constructed** — review is a YELLOW no-op, so "RED at review blocks ship" cannot fire.

## Gap table

> **Do not route (G312):** Rows below are a **pre-P7 snapshot** — **Blocks loop?** and **Net verified gap** overstate open work at **1.5.x** (gap-review **G312**, **G167**). Builder routing: **`SELF-BUILD-DEVELOPER-LOOP.md`** §Phases + **`../../gaps/README.md`** only.

| Phase | Required | Already present | Net verified gap | Blocks loop? | Effort |
|---|---|---|---|---|---|
| **P3 — DEBUG-on-red bounded repair** | Parse RED gate output → structured failure note → re-BUILD → re-run only the failed gate, capped by `maxRepairAttempts` AND a token budget; give-up → blocker + RED packet + advance. | RED detection point (`selfBuildExecutor.ts:297`), gate raw stdout/stderr/exitCode (`gates.ts`), give-up sink (`buildBlockedReport`/`recordBlocker`), retry-loop shape to mirror (`runPlannerWithRetries:451`, provider rotation only). | No gate parser (`parseGateOutput`/`parseVitest`/`parseTsc` = 0), no repair sub-loop (RED unconditionally returns), no `maxRepairAttempts` knob (schema `.strict()`), no token/$ budget, give-up "advance" unimplementable (single-task executor). | **Yes** | L |
| **P4 — SELECT scoring + LEARN flywheel** | `scoreTask` re-ranks ready tasks from stored outcomes; DAG-exhausted → resolver proposes; LEARN writes one validated fact + parks confidence + feeds blockers back to SELECT; boot upserts/closes gap records for absent git/gh/coderabbit. | Task DAG + `planNextSelfBuildTask` (priority+id only), outcome writes (`createImplementation`/`recordBlocker`/`recordDonePacket`), full flywheel/resolver/gap-records (REPL-wired), evidence proposals (CLI-only). | `scoreTask` = 0; `OperationalStore` has no `listImplementations`/outcome reader; no DAG-exhausted resolver proposal in SELECT; executor imports no memory/garage/roles handle → no validated fact / no park; no blocker feedback to SELECT; no git/gh/coderabbit gap-record upsert on executor boot. | No | L |
| **P5 — SHIP: git-if-present + local fallback** | Probe presence: git → commit/push, PR iff gh; git absent → durable on-disk change-record + done packet surviving restart; deploy/spend verbs always hard-edge-escalate. | git+gh automation wired (`runGitPrAutomation`, `selfBuildExecutor.ts:347`), dry-run default, protected-branch/arg-injection guards, `commandExists` exported (`gates.ts:9`). | Ship never probes git (`options.git?.enabled` only, gated behind `--git`), no `commandExists('gh')` guard (git-yes/gh-no → RED), no local on-disk change-record, delivery record in-memory-only by default, ship path bypasses `executeTool` (`prAutomation.ts:91,149`) → no mandate/spend gate on deploy verbs. | **Yes** | M |
| **P6 — Safety envelope** | Mandate/spend hard-edge enforced on the executor path; host-allowlist net classifier; paid-attach = spend; `SpendBudget` (ceiling+total, $0 denies all); VETO/STEER/BATCH/KILL + escalation circuit-breaker; persisted approval ledger in every packet; global token+wall-clock+iteration budget over loop + nested guru-calls; YOLO regression holds. | Real un-liftable hard-edge in `evaluateToolMandate` (`evaluate.ts:178-185`, hard-edge before YOLO), bash SPEND_PATTERNS, static pre-run `collectRunSafetyBlockers`, attempt caps (`plannerMaxRetries`, `maxIterations`). | Executor builds runtimes with no `mandatePolicy` (`:125-129`, `:469-474`) → hard-edge never fires on `guru run`; no host classifier; `resolve_capability_gap` → `[]`; no `SpendBudget`; no levers/circuit-breaker; no ledger field in `DonePacketSchema`; no token/wall-clock budget; `SelfBuildConfigSchema` `.strict()` blocks new knobs. | No (safety-correctness, load-bearing) | L |
| **P7 — runDevCycle orchestrator + driver** | Single `runDevCycle(state)` wrapping `runSelfBuildExecutor`, driving 0→7 as pure `{verdict,evidence,nextStage}` transitions; `guru self-build --run` + `--dry-run` (prints gates, executes nothing); per-stage events; cross-task resume; mandate policy injected; global budget + KILL. | Single-pass executor to wrap, resume-by-session-id (`:156-159`), SELECT primitives, standalone `runSelfBuildLoop` reference (uncalled), native-reviewer seam (injection-ready), SMOKE/discoverGates modules, `AgentSession.driveTurn` + `capabilitySmoke`. | `runDevCycle` = 0; no `--run`/whole-cycle `--dry-run`; no live reviewer constructed; TEST/SMOKE never called by executor; no DEBUG loop; no SELECT-score/LEARN arc; **mandate policy never injected into the executor runtime from any surface**; no global budget/KILL/circuit-breaker; no 0→7 events, no ledger, no work-classification pause. | **Yes** | L |
| **Acceptance + Safety** | 8 stages run unattended with git/gh/coderabbit absent + spend verb hard-stops even in YOLO + persisted ledger survives restart. | Hard-edge engine + per-call approval real (REPL/API-tool-run only), static pre-run guard, dry-run-default ship, done-packet contract, attempt caps. | Hard-edge NOT on the executor path (worst-case: autonomous run can spend/destruct with only static scan); no budget/ledger/levers; runDevCycle absent → test unrunnable end-to-end; discoverGates/smokeStage/makeNativeReviewer built but test-only (TEST/SMOKE/live-review/local-ship legs missing). | **Yes** | L |

> **Row P4 (gap-review pass 160, G896):** **`scoreTask`** / **`selectNextTask`** ship in **`src/selfbuild/selectTask.ts`**; default CLI **`--loop`** history is in-process only — no **`outcomeStore.ts`** / **`task-outcomes.json`** (**G889**/**G52**).
>
> **Row P5 (gap-review pass 160, G895 / G879):** Executor **`selfBuildExecutor.ts` L361–393** fail-closes live automation on synthetic **`git push`** when **`mandatePolicy`** is set; **`prAutomation.ts`** still runs **`git add`/`commit`/`push`/`gh pr create`** via **`executeCommand`** without per-step mandate (**G877**). **`makeGatedGitDelivery`** on dev-cycle SHIP (**HARDENING [10]**). Historical “bypasses **`executeTool`** only” prose is incomplete at 1.5.x.
>
> **Row P7 (gap-review pass 161, G903 / G883):** **`runDevCycle`** + **`guru self-build-run`** ship (`cli.ts` L248–338; **`runDevCycle.ts`** injects **`failClosedMandatePolicy`**); **`--dry-run`** previews via **`buildDevCyclePlan`**. Residual: CLI omits **`ledger`**/**`recordFact`** (**G901**); bare **`guru run`** / API **`POST /run`** still weak (**G661**/**G739**). Table “**`runDevCycle` = 0**” is obsolete.
>
> **Row P6 (gap-review pass 162, G907 / G661):** **`guru run`** injects **`mandatePolicy`** only for **`--git-live`** push pre-check (`cli.ts` L208–215); default **`guru run`** (no live git) omits policy on **`runSelfBuildExecutor`**. **`guru self-build-run`** always uses **`runDevCycle`** fail-closed policy on the full cycle. Table “hard-edge never fires on **`guru run`**” is **mostly true** except live-git path.
>
> **Row Acceptance (gap-review pass 163, G916):** **`runDevCycle`** + **`guru self-build-run`** make end-to-end P7 runnable; **`POST /run`** still bare **`runSelfBuildExecutor`** without policy (**`api.ts`** **`defaultRun`**). “**runDevCycle absent**” in this row is obsolete; ledger/outcome persistence gaps remain (**G908**/**G913**).
>
> **Dry-run preview (gap-review pass 164, G918):** **`guru self-build-run --dry-run`** calls **`buildDevCyclePlan({ cwd, taskId })`** without **`hasSmoke`**/**`hasReviewer`**/**`hasGitDelivery`** — plan shows SMOKE/REVIEW "not wired → YELLOW" while live **`runDevCycle`** wires **`makeSmokeDeps`** + optional **`askModel`** (**G121**/**G323**).
>
> **Row P3 (gap-review pass 165, G926):** **`parseGateFailure`** + DEBUG stage in **`runDevCycle.ts`** (TEST RED → note → **`defaultRepair`** re-BUILD); **`DevCycleBudget`** bounds re-entries. Residual: no separate **`maxRepairAttempts`** schema knob; table “no gate parser” is obsolete. Re-run-only-failed-gate is via **`nextStage`** routing, not isolated gate replay.
>
> **Row P5 (gap-review pass 166, G941):** **`runShipStage`** (**`shipStage.ts`**) probes **`commandExists('git')`**/**`gh`** and writes durable **`.guru/change-records`** when git delivery unwired — table body “Ship never probes git” is obsolete. Residual: **`runGitPrAutomation`** still **`executeCommand`** without per-step **`mandatePolicy`** (**G877**/**G895**); dev-cycle SHIP uses **`makeGatedGitDelivery`** when wired (**HARDENING [10]**).
>
> **Dry-run vs live (gap-review pass 167, G946):** Live **`self-build-run`** wires **`makeSmokeDeps`** + optional **`askModel`**; **`--dry-run`** omits **`hasSmoke`**/**`hasReviewer`** on **`buildDevCyclePlan`** — preview understates wired legs (**G929**). **`DevCycleReport.ledger`** ships when **`input.ledger`** set; CLI never loads/saves ledger (**G948**).
>
> **Hooks + spend (gap-review pass 168, G954/G956):** **`tool:result`** lifecycle type exists; runtime emits **`tool:execute`** only — no **`tool-result`** shell hook (**G846**). **`canSpend`**/**`recordSpend`** on **`DevCycleBudget`** unused in **`runDevCycle`** (**G928**).
> **Compaction RPC (gap-review pass 169, G959):** Engine + config ship; **`wireRpcEvents`** omits compaction stream — extension **`session_compact`** seams documented as future in **`compaction/engine.ts`** (**G532**).
> **LEARN CLI (gap-review pass 170, G975):** **`runDevCycle`** **`recordFact`** optional; **`guru self-build-run`** does not wire LEARN persistence (**G964**/**G52**).
> **SELECT scoring (gap-review pass 171, G982):** **`scoreTask`** uses priority/blockers only — no persisted outcome store; **`runDevCycleLoop`** does not fold **`learned`** into **`TaskOutcomeHistory`** (**G973**/**G889**).
> **Dry-run honesty (gap-review pass 172, G985):** **`--dry-run`** omits **`hasSmoke`**/**`hasReviewer`** mirrors — preview may show SMOKE/REVIEW unwired while **`self-build-run`** wires **`makeSmokeDeps`** + **`askModel`** (**G970**/**D13**).

## Critical path

- **P6 (mandate injection + SpendBudget + token/wall-clock budget) — FIRST.** The one un-liftable law (SPEND is the hard gate) is currently false on the executor path, and every later phase (autonomous DEBUG re-plans, resolver attach, autonomous SHIP) *adds spend surface*. Nothing autonomous may run before the choke point and budget exist.
- **P7 (thin `runDevCycle` spine) — SECOND.** The 0→7 state machine is the keystone that wires the already-built organs onto one live spine; it is also the natural home to *inject* the P6 policy/budget/KILL into the executor runtime. Building it as a thin wrapper immediately makes BUILD/TEST/SMOKE/REVIEW run end-to-end.
- **P5 (SHIP presence-detect + local fallback) — THIRD.** Once the spine runs, delivery must degrade-not-fail on the fresh git-optional machine (probe git/gh, else durable on-disk change-record). Small, self-contained, unblocks the git-absent acceptance leg.
- **P3 (DEBUG bounded repair) — FOURTH.** With the spine + budget in place, wire the repair sub-loop into the TEST/SMOKE-RED branch — safe only because P6's token budget now bounds re-plans.
- **P4 (SELECT-score + LEARN) — FIFTH.** The self-improvement arc; the loop runs correctly without it, so it lands last, mostly plumbing existing REPL organs (flywheel/resolver/gap-records) into the executor rather than re-implementing.

## Next priority build

**Build a thin `runDevCycle` orchestrator spine (P7) that INJECTS the P6 mandate policy + a global attempt-and-token budget into the executor runtime as its first act, then drives SELECT → BUILD → TEST(discovered) → SMOKE → SELF-REVIEW → SHIP → LEARN over `runSelfBuildExecutor`, with DEBUG/SHIP-fallback/LEARN as no-op-safe seams.**

**Rejected alternative — "build the remaining organs P3→P6 in sequence, wire the spine last."** Rejected because it leaves the loop unrunnable end-to-end for the entire build (every organ stays a test-only island, exactly today's failure mode), and because it defers the single most dangerous fact — the executor path has no spend gate — behind three other phases. The organs are already built; the risk toward THERE is dominated by *integration and the spend hard-edge*, not by missing modules.

**Why the thin spine first most reduces risk:** P7 is the only phase that (a) makes the already-built BUILD/TEST/SMOKE/REVIEW organs actually run on one live spine, giving a real end-to-end signal to measure every later phase against, and (b) is the correct injection site for the P6 choke point. Folding the *mandate-injection + budget* subset of P6 into the P7 spine as its non-negotiable precondition closes the load-bearing safety hole at the exact moment autonomy is first enabled — instead of shipping an ungated autonomous driver and back-filling safety later. P3/P4/the live native reviewer then plug into named seams the spine already exposes. This is a wrap-not-replace build: `runSelfBuildExecutor` stays the single-task substrate.

## Goal (ready to run)

**Ship `runDevCycle` — a budget-and-mandate-gated 0→7 orchestrator that wraps `runSelfBuildExecutor`.**

### Scope
- New `src/selfbuild/runDevCycle.ts` exporting `runDevCycle(input): Promise<DevCycleReport>`. It **wraps** `runSelfBuildExecutor` (does not fork it), advancing one task through stages as pure transitions `Stage → { verdict: 'GREEN'|'YELLOW'|'RED', evidence, nextStage }`.
- **Inject the mandate/spend choke point into the executor runtime.** Add an optional `runtime`/`mandatePolicy` seam to `RunSelfBuildExecutorOptions` and thread it into BOTH `createHarnessRuntime` calls (`selfBuildExecutor.ts:125-129` and the planner sub-runtime `:469-474`). `runDevCycle` constructs a `headlessMandatePolicy` (reuse `surfaces/api.ts:189`) and passes it. With no policy the executor MUST refuse to run any mutating stage (fail-closed), not silently proceed.
- **Global budget object** `DevCycleBudget` bounding the whole loop AND every nested guru-call: `maxIterations` (attempt cap) **and** `tokenBudget` (cumulative, consumed from `AgentSession.stats()`/planner usage) **and** `wallClockMs`. A `SpendBudget { ceilingUsd, spentUsd }` where `ceilingUsd: 0` denies ALL spend verbs. Add these to a **new** `RunDevCycleConfigSchema` (a *new* strict block — do not mutate `SelfBuildConfigSchema` beyond adding the nested block, since it is `.strict()`).
- Wire the existing organs into their stages: **TEST** → `runDiscoveredValidation` (project-discovered scripts, `discoverGates`), **SMOKE** → `runSmokeStage` with a real injected `capabilitySmoke` + one timeout-bounded `driveTurn` self-call, **SELF-REVIEW** → construct a real `makeNativeReviewer(askModel, panel)` from `config.reviewGate.panel` and pass it as `nativeReviewer` (the seam at `selfBuildExecutor.ts:294` already forwards it).
- **DEBUG, SHIP-local-fallback, LEARN are named seams** in this build: typed stage hooks that default to no-op-passthrough (returning YELLOW-with-note), so P3/P5/P4 plug in without touching the spine.
- Surface: `guru self-build --run` (CLI/TUI/API) plus `--dry-run` that **discovers and PRINTS gates/commands/stage plan and executes nothing**. Per-stage progress events emitted through the existing beacon store. Cross-task resume by session id (reuse `startOrResumeSession`).
- All new code TypeScript, Zod-`.strict()` schemas, Vitest, every dependency (askModel, capabilitySmoke, driveTurn, clock, budget, store) dependency-injected.

### Acceptance (testable)
- `runDevCycle` drives one task through all 8 stage slots and returns a `DevCycleReport` with an ordered per-stage `{verdict, evidence, nextStage}` trace; a RED at SELF-REVIEW sets `nextStage` to terminate and blocks SHIP (native reviewer constructed and actually invoked, not YELLOW-by-absence).
- **Spend hard-stops even in YOLO:** a control task whose plan contains a spend verb escalates (never auto-allows) with `yolo:true` set — asserted against the injected mandate policy on the executor runtime, not just the REPL.
- **`$0` SpendBudget denies all spend;** a non-zero ceiling permits within budget and denies once `spentUsd` would exceed `ceilingUsd`.
- **Every model loop is doubly bounded:** a stubbed planner/self-call that never converges halts on the attempt cap **and** independently on `tokenBudget` exhaustion **and** on `wallClockMs` — three separate tests, each asserting the loop stops and emits a bounded RED, not a hang.
- **`--dry-run` executes nothing:** with an executor spy, dry-run prints discovered gates + the stage plan and the spy records zero tool/command/model calls.
- **Presence-over-value:** with git and gh both absent (injected `commandExists` → false), the run reaches the SHIP seam and returns a done packet via the local-fallback seam (no RED-by-absence); no gate assumes any external tool exists — TEST uses only project-discovered scripts.
- Interrupted run resumes: a run aborted mid-cycle, re-invoked with the same session id, continues from the recorded stage.
- Done packet carries validation + native-review evidence and an approval-ledger field (ledger persistence itself may be a P6 seam, but the field is present and populated from the injected policy's decisions).

### Guardrails
- **SPEND is the one hard gate:** the executor runtime MUST carry the mandate policy before any mutating stage runs; a missing policy is fail-closed RED, never a silent proceed. Hard-edge verbs (`spend`/`destructive`/`secret-edge`/`auth-edge`) escalate before the YOLO branch — do not weaken `evaluateToolMandate`'s ordering.
- **Every model loop bounded by attempt cap AND token budget** — no loop may rely on an integer counter alone; `tokenBudget` and `wallClockMs` are mandatory and independently sufficient to halt.
- **Assume NO external tool exists:** probe with `commandExists` (never assume `git`/`gh`/`vitest`/`tsc`); TEST is project-discovered; absence degrades to a legible YELLOW/local path, never RED-by-absence.
- **Presence-over-value for secrets:** the run detects credential presence, never reads or logs values; keep the static `collectRunSafetyBlockers` secret scan in the pre-run path.
- **Wrap, don't fork:** `runSelfBuildExecutor` remains the single-task substrate; `runDevCycle` only orchestrates, injects, and bounds. `.strict()` schemas mean new knobs go in a new nested block, not by loosening existing ones.
- **No autonomous SHIP-live without approval:** keep `dryRun` default true and the `approvalPolicy.autoCommitPushPr` gate; the spine must not auto-flip live ship.

## Residual risks

- **Injection done but bypassed:** the git ship steps call `executeCommand` directly (`prAutomation.ts:91,149`), sidestepping `runtime.executeTool`. Injecting a mandate policy into the runtime does NOT gate the ship path until SHIP is routed through the gated executor or given its own pre-exec mandate check — a deploy verb on the ship plan could still run unchecked. Must be closed in P5.
- **Token-budget fidelity:** cost/token accounting depends on `AgentSession.stats()`/planner usage being accurate and summed across nested guru-calls; an unmetered nested call (e.g. a resolver-triggered sub-agent) could escape the ceiling. The budget must be threaded into every nested call, not just the top loop.
- **Native reviewer quality gate:** a live `makeNativeReviewer` that mis-synthesizes verdicts (false GREEN on a bad diff, or thrash) undermines "RED blocks ship." The seeded-bad-diff acceptance test is the only guard; keep it adversarial.
- **Divergent LEARN path (P4):** the flywheel/resolver/gap-records already exist REPL-side; the temptation to re-implement rather than plumb them risks a second, divergent LEARN loop. P4 must inject the existing organs into the executor, not clone them.
- **DEBUG thrash (P3):** a naive gate-output parser feeding bad failure notes causes fix-break-fix churn that burns the whole token budget without converging — the budget bounds cost but not correctness; the parser must be conservative and the repair loop must re-run only the failed gate.
- **Restart durability:** the executor's default `createInMemoryOperationalStore` means the approval ledger and done packet do not survive a restart until a file/Postgres-backed store is the default on the self-build path — required for the acceptance "survives restart" leg.