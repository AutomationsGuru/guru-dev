> **Note (2026-07-10):** CodeRabbit is retired from GuruHarness. Review is peer-agent + native critic panel + CI only. Historical mentions of CodeRabbit below are archival.

# The Self-Build Developer Loop — a plan to make guru replace the builder

> **Goal:** make the self-build loop robust enough to replace the human-driven builder — autonomously SELECT → BUILD → TEST → CALL/SMOKE → DEBUG → REVIEW → SHIP → LEARN.
>
> **Foundational laws (non-negotiable):** (1) assume ONLY guru + an AI-model connection; (2) get everything else yourself (build/attach/learn), autonomous when free; (3) **SPEND is the one hard gate** — "guru can do anything unless it costs money." Every gate is guru-native or discovered-from-the-project; CodeRabbit/GitHub/git are attach-if-present overlays, never assumed. The review gate is guru's OWN model-powered adversarial critic panel — CodeRabbit only enriches it when present.

## Current state (v1.5.x P7 — doc-control pass-532)

**Builder routing:** use **Phase status** below and **`../../gaps/README.md`** (scheduler gap-review pass **181**; guru-vs-matrix pass **74** (**G1116**–**G1119**); harness-matrix pass **78**; guru-vs **G1108**–**G1115**); e.g. G8/**G582**/**G583**/**G584**/**G681**/**G755**/**G785** README `guru run` vs **`self-build-run`**, **G809**/**G810**/**G811** dry-run/config + token/wall-clock (**G778**/**G563**/**G927**/**G928**), **G804** loop budget reset, G26/**G477**/**G469**/**G554** (toolParity **YELLOW**; **G936** `manage_task` vs matrix background **P**), G52/**G528**/**G560**/**G581**/**G901**, G91, G102, **G323**/**G437**/**G929**, G331, G411, **G480** shipped config, G356 overlay B2, **G557**/**G585**/**G779**; headless RPC **G532**/**G937**/**G523**/**G569**/**G756**/**G708**/**G788**/**G627** — Pi audit §10 vs `../src/surfaces/rpc.ts` **8** methods; **`guru api`** **12** HTTP routes). **Defect audit:** `SELF-BUILD-LOOP-HARDENING.md` (reconciliation banner pass-374; **[3]**/**[9]**/**[12]** open per **G557**/**G563**/**G560**/**G581**). **Build plans:** `../../handoffs/build-plans/README.md` — overlay **`1530Z`** incl. **G502**; G13/G156/G627/G656/G681. **Operator CLI:** `guru self-build-run` drives `runDevCycle` with fail-closed **`mandatePolicy`**; **`guru run`** injects policy only on live git (**G583**/**G753**). **Do not use** `SELF-BUILD-LOOP-GAP.md` gap table for routing — stale vs code (**G312**, G167/**G290**). **Residual holes:** headless API `POST /run` and TUI `run` omit executor `mandatePolicy` (G8/G225/**G584**/G156/**G639**/**G681**/**G860**/**G862**/**G922**); P6 classifier/circuit-breaker; CLI ledger/outcome persistence (G52/G191/**G513**/**G560**/**G975**/**G972**); bash background ingress (**G974**/**G923**); **`--dry-run`** omits smoke/reviewer/git flags (**G809**/**G323**/**G929** / doc-control **D13**); `schedule` tool lacks default **`onSchedule`** (**G26**/**G477**). **Code-review nav:** `../../handoffs/code-reviews/INDEX.md` recheck **`2349Z`** (INDEX pass-**529**). **toolParity:** **23** GREEN / **4** YELLOW (**G730**, pass **132**).

> **Provenance:** the pre-P7 “ten gaps” bullet list (CodeRabbit-only review, no driver, etc.) was removed here — it contradicted shipped P0–P5 and misrouted implementers (gap G154). Historical snapshot: `SELF-BUILD-LOOP-GAP.md` (superseded banner only).

## Operator entrypoints (mandate-aware)

Use this table when routing builders or dogfood — not interchangeable paths (**G755** / gap-review **136**).

| Entry | Surface | Executor `mandatePolicy` | Notes |
| --- | --- | --- | --- |
| **`guru self-build-run`** | `runDevCycle` / `runDevCycleLoop` | **Fail-closed** injected | Canonical 0→7 loop; `--dry-run` plan only (**G323**). |
| **`guru run`** | `runSelfBuildExecutor` (CLI) | **Only when live git** (`git.dryRun === false`) | Dry-run / default CLI may omit policy (**G583**/**G753**). |
| **`POST /run`** (`guru api`) | `defaultRun` → `runSelfBuildExecutor` | **None** | Executor-only — no P7 **TEST/SMOKE** (**G862**); JSON **`git.dryRun: false`** accepted without server **`allowRunSafetyOverrides`** (**G860**); headless mandate gap (**G582**/**G681**/**G739**). |
| **TUI `run`** | `surfaces/tui.ts` | **None** | Interactive slash path (**G584**/**G743**/**G156**). |

Product capability table: `../README.md` (Autonomous one-shot run row). Build plan: `../../handoffs/build-plans/2026-07-15T0354Z-g156-headless-tui-run-mandate-gap-plan.md` (**G156**).

## Target architecture
One orchestrator `runDevCycle(state)` that **wraps** `runSelfBuildExecutor` (doesn't replace it), advancing task-by-task; each stage a pure transition `{verdict, evidence, nextStage}`; every action routes through the single mandate choke point whose spend hard-edge YOLO cannot lift.

```
[BOOT: kernel assert → garage inspect → memory inject → WORK DECLARE → baseline health]
      |  (gap records for git/gh/coderabbit re-evaluated every boot)
      v
(0) SELECT ── planNextSelfBuildTask + scoreTask(outcomes); DAG-exhausted → resolver
      |                                                              ^ LEARN feeds back
(1) BUILD ─── planner + file-edit tools, mandate floor per step
      v
(2) TEST ──── discoverGates(repo) [package.json/Makefile/Cargo…] → runReviewGates (exit-code); none → YELLOW
      v
(3) SMOKE ─── capabilitySmoke (nucleus boots) + one AgentSession.driveTurn self-call (timeout-bounded)
      |
      +─RED at TEST/SMOKE→ (4) DEBUG (bounded repair: ≤maxRepairAttempts + token budget)
      |                          parse gate output → failure note → re-BUILD → re-run only failed gate
      v                          give-up → recordBlocker + RED packet → advance (never hang)
(5) SELF-REVIEW ── native adversarial critic panel (REPLACES CodeRabbit): N read-only personas
      |    (Security/Correctness/Contract-&-regressions/Simplicity) → independent VERIFY pass →
      |    GREEN iff surviving CONFIRMED-high set is empty. coderabbit/gh attach IF commandExists().
      v
(6) SHIP ──── commandExists('git')? git commit/push (+PR iff gh) : LOCAL-DELIVERY on-disk change-record.
      |        SPEND verbs (deploy/provision) hard-edge-escalate on EITHER path.
      v
(7) LEARN ─── done-packet + gate outcomes + repair history → operationalStore + validated memory fact;
      |        park capability confidence; feed blocker signals back to (0)
      v
[loop under GLOBAL BUDGET: max-iterations + wall-clock + token/$ ceiling; any SPEND pauses for the operator]
```

## Phases

**P0 — De-assume the review gate** ✅ **DONE (v-wip, 996 tests green).** Widen `ReviewGateSchema.provider` → `enum(['native-critic-panel','coderabbit','command'])`, default `native-critic-panel`, `command` optional; migration shim so legacy `coderabbit` configs load unchanged; export `commandExists()`. *Accept:* existing config behaves identically; bare config defaults to native; no consumer signature changes.

**P1 — Native adversarial critic panel** ✅ **DONE (module + gate integration; the live model-reviewer wiring is deferred to P7).** `runNativeCriticPanel()` → a `CommandGateResult`-shaped verdict; bind a runner to the swarm manager; spawn N **read-only** persona critics (each physically cannot write); independent **VERIFY** pass (confirm-with-repro or refute; majority-refute kills false positives); GREEN only when surviving CONFIRMED-high is empty — **synthesis is code, not model discretion**. coderabbit/gh append as `required:false` overlays if present. *Accept:* real verdict with zero external tools; a seeded bad diff → RED, clean → GREEN; every critic asserted read-only before spawn; caps never exceeded.

**P7 spine — IN PROGRESS** (`src/selfbuild/devCycle.ts` + `runDevCycle.ts`). Slice 1: `DevCycleBudget` (attempt+token+wall-clock bounds, `$0`-denies-all spend) + pure `nextStage` 0→7 reducer. Slice 2: **spend-gate hole CLOSED** — `RunSelfBuildExecutorOptions.mandatePolicy` threaded into both runtimes; `runDevCycle` wraps the executor and injects a fail-closed policy + budget by default. **`guru self-build-run`** runs discovered TEST gates (`discoverGates`) + wired SMOKE; DEBUG/LEARN/SHIP stages live on this path (P3–P5 below). Remaining: live-REVIEW depth, CLI ledger/outcome persistence, P6 host classifier + circuit-breaker; legacy API `POST /run` (`defaultRun`) still omits executor mandate policy.

**P2 — Gate discovery + TEST/SMOKE.** ✅ **DONE (`src/selfbuild/discoverGates.ts` + `smokeStage.ts`, 15 tests).** `discoverGates()` reads the project's OWN `package.json .scripts` / Makefile / Cargo.toml / pyproject / go.mod → argv; none → YELLOW, never crash. SMOKE = capability-smoke + one timeout-bounded self `driveTurn`. *Accept:* npm repo → its scripts, Rust → `cargo test`, scriptless → YELLOW; broken `tsc` → RED→DEBUG; a hanging change is aborted, not hung.

**P3 — DEBUG-on-red bounded repair.** ✅ **DONE (dev-cycle path)** — `parseGateFailure.ts`, DEBUG stage + default re-plan repair in `runDevCycle.ts`, bounded by `DevCycleBudget`. *Residual:* executor-only / API `defaultRun` paths. *Accept:* one-line fix repaired in budget; unfixable → bounded blocker; spend never exceeds budget.

**P4 — SELECT scoring + LEARN flywheel.** **PARTIAL** — `selectTask`/`scoreTask`, `deriveLearning`, `runDevCycleLoop` in-process history; operational-store / `.guru` outcome persistence not on CLI yet (`SELF-BUILD-LOOP-HARDENING.md`, `../../gaps/README.md` G52). *Accept:* failed task-type deprioritized; GREEN writes one fact, RED writes a blocker; gap record for `gh` closes once it appears.

**P5 — SHIP: git-if-present + local fallback.** ✅ **DONE (dev-cycle path)** — `shipStage.ts`, `makeGatedGitDelivery` + mandate gate on live git. *Accept:* the three presence combinations behave correctly; a deploy verb always prompts.

**P6 — Safety envelope.** **PARTIAL** — bash spend heuristics + hard-edge verbs (`mandates/evaluate.ts`); `SpendBudget` / `DevCycleBudget` on dev-cycle; optional `approvalLedger` on `runDevCycle`. **Open:** host-allowlist net classifier, VETO/STEER/BATCH/KILL circuit-breaker, default persisted ledger on operator CLI/API (`../../gaps/README.md` G91). *Accept:* YOLO still can't spend/destroy/touch-secrets (regression); non-baseline net → spend; $0 budget denies all spend; circuit-breaker pauses on N escalations; every mutation's packet has a persisted ledger; KILL aborts all workers.

**P7 — `runDevCycle` orchestrator + driver.** **PARTIAL** — 0→7 state machine in `runDevCycle.ts`; operator CLI **`guru self-build-run`** (`--dry-run` stage plan only, `--loop` multi-task, `--task-id`); loop progress on stderr; JSON cycle report on stdout. **Open:** resume interrupted dev-cycle by session id; work-classification pause (`../../gaps/README.md` G102); align **`cli.ts`** dry-run with run-path wiring signals (`hasSmoke: true`, `hasReviewer: keyPresent`) per **G323**. *Accept:* one task end-to-end with native-critic REVIEW (peer + CI per `REVIEW-PROCESS.md` — CodeRabbit retired); `git`/`gh` optional (degrade paths OK); dry-run executes nothing (plan text should match wired stages once G323 fixed); RED at review blocks ship; halts on budget + KILL.

## Safety envelope (threaded through every phase)
- **Spend is the one un-liftable hard gate** — `evaluate.ts` escalates hard edges before YOLO; P6 widens *what counts as spend* but never weakens it.
- **Every gate guru-native or discovered** — validation = the project's own scripts; review = the native panel; absence degrades to YELLOW, never RED-by-absence.
- **The constitution is preserved verbatim** — only its *inputs* become self-owned. No unattended self-improvement across a spend edge, ever.
- **Anti-rubber-stamp in code** — read-only critics, independent lenses, a separate repro-required VERIFY pass, majority-refute, GREEN only on empty CONFIRMED-high.
- **Bounded everything** — per-task timeout, bounded repair, swarm caps, a global token+wall-clock+iteration budget.
- **Matt's backstop = four legible levers over a persisted ledger** — VETO / STEER / BATCH (explicit ceiling, not the forbidden "always") / KILL + circuit-breaker.
- **Local-only durability** — change-record + audit ledger are real on-disk artifacts when git/Supabase are absent.

## The "replaces-the-builder" acceptance test
On a **fresh machine, only guru + one model key** — no CodeRabbit, no gh, one variant no git — `guru self-build-run` (optional `--loop`) on this repo, unattended: SELECT (states why) → BUILD (real edits) → TEST (its *discovered* scripts) → SMOKE (self-call) → DEBUG (seeded-fixable repaired; seeded-unfixable bounded) → SELF-REVIEW (native panel catches a seeded bad diff as RED, passes a clean one, CodeRabbit never invoked) → SHIP (git→push, else on-disk record) → LEARN (one validated fact). A control task with a **spend verb hard-stops for approval even in YOLO**. Every mutation ships a done packet with validation + native-review evidence + a **persisted** approval ledger that survives a restart. **PASS = 1–8 unattended + 9 stops on spend + 10 survives restart, all with CodeRabbit/gh/(git) absent.**

## Open decisions for Matt
1. **Critic-panel size vs cost** — personas (default 4) + verifiers per finding; the worker cap + per-review token budget.
2. **Severity→verdict policy** — what's "high" (RED) vs "medium" (YELLOW); the single calibration knob.
3. **Single-model blind spot** — the native panel runs on the one baseline model (shares the author's blind spots). Accept, with CodeRabbit-when-present as the only independent cross-check — or authorize a SECOND provider for high-severity reviews (itself potential NEW spend → trips Law 3)?
4. **SpendBudget default** — $0 (every spend prompts) or a standing session ceiling as the BATCH default? And is an approved-but-mispriced op an acceptable residual risk (no rollback)?
5. **Work-classification** — all free changes fully autonomous, or force a human-checkpoint on sensitive classes (edits to `mandates/`, `safety/`, `config/`, or the review gate itself)?
6. **Local-only ship** — is an on-disk change-record acceptable delivery without version control, or must it refuse to "ship" without a VCS target?
7. **Cost-estimate honesty** — approve on "unknown cost", or auto-DENY unknown-cost ops until a cost can be derived?
