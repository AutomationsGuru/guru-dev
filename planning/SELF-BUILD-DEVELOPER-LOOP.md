> **Note (2026-07-10):** CodeRabbit is retired from GuruHarness. Review is peer-agent + native critic panel + CI only. Historical mentions of CodeRabbit below are archival.

# The Self-Build Developer Loop — a plan to make guru replace the builder

> **Goal:** make the self-build loop robust enough to replace the human-driven builder — autonomously SELECT → BUILD → TEST → CALL/SMOKE → DEBUG → REVIEW → SHIP → LEARN.
>
> **Foundational laws (non-negotiable):** (1) assume ONLY guru + an AI-model connection; (2) get everything else yourself (build/attach/learn), autonomous when free; (3) **SPEND is the one hard gate** — "guru can do anything unless it costs money." Every gate is guru-native or discovered-from-the-project; CodeRabbit/GitHub/git are attach-if-present overlays, never assumed. The review gate is guru's OWN model-powered adversarial critic panel — CodeRabbit only enriches it when present.

## Current state (honest)
Guru already has ~85% of the *organs*, just not wired into one loop, and two constitutional inputs are external assumptions:

- **Present:** task DAG + selection (`selfBuildLoop.ts` `planNextSelfBuildTask`); end-to-end orchestrator (`selfBuildExecutor.ts`, 1008 lines); command-abstracted gates with exit-code verdicts (`review/gates.ts`); the AgentSession engine (`driveTurn`/park); a swarm manager ready for a critic panel (but no runner bound by default); the **spend hard-edge is real and un-liftable** (`evaluate.ts:178-180` escalates hard edges *before* the YOLO branch); the never-stuck resolver; dry-run-by-default git/PR automation; capability smoke; the done-packet contract.
- **The gaps:** (1) review is **hard-coded to CodeRabbit** (`config/schema.ts:22` `z.enum(["coderabbit"])`) → a fresh machine goes RED-by-absence; (2) no native adversarial review; (3) no autonomous driver; (4) no gate *discovery* (validation commands are config-declared, not read from the project); (5) no debug-on-red repair sub-loop; (6) no local-only ship fallback; (7) spend is detected only on bash strings (blind to paid net/attach); (8) no persisted approval ledger / budget / kill-switch; (9) budget counts steps, not tokens/$; (10) no work-classification.

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

**P7 spine — IN PROGRESS** (`src/selfbuild/devCycle.ts` + `runDevCycle.ts`). Slice 1: `DevCycleBudget` (attempt+token+wall-clock bounds, `$0`-denies-all spend) + pure `nextStage` 0→7 reducer. Slice 2: **spend-gate hole CLOSED** — `RunSelfBuildExecutorOptions.mandatePolicy` threaded into both runtimes; `runDevCycle` wraps the executor and injects a fail-closed policy + budget by default. 1015 tests green. Remaining: run TEST/SMOKE/live-REVIEW as real stages (executor still uses static validationCommands), then P5→P3→P4.

**P2 — Gate discovery + TEST/SMOKE.** ✅ **DONE (`src/selfbuild/discoverGates.ts` + `smokeStage.ts`, 15 tests).** `discoverGates()` reads the project's OWN `package.json .scripts` / Makefile / Cargo.toml / pyproject / go.mod → argv; none → YELLOW, never crash. SMOKE = capability-smoke + one timeout-bounded self `driveTurn`. *Accept:* npm repo → its scripts, Rust → `cargo test`, scriptless → YELLOW; broken `tsc` → RED→DEBUG; a hanging change is aborted, not hung.

**P3 — DEBUG-on-red bounded repair.** Parse gate output (vitest/tsc/generic) → structured failure; repair sub-loop capped by `maxRepairAttempts` + token budget, carrying the failure note forward; give-up → blocker + RED + advance. *Accept:* one-line fix repaired in budget; unfixable → bounded blocker; spend never exceeds budget.

**P4 — SELECT scoring + LEARN flywheel.** `scoreTask` re-ranks ready tasks from operational-store outcomes; DAG-exhausted → resolver proposals; LEARN writes validated memory + implementation record + parks confidence; boot upserts gap records for absent git/gh/coderabbit. *Accept:* failed task-type deprioritized; GREEN writes one fact, RED writes a blocker; gap record for `gh` closes once it appears.

**P5 — SHIP: git-if-present + local fallback.** git present → commit/push (+PR iff gh); git absent → durable on-disk change-record + done packet (survives restart); spend untouched either way. *Accept:* the three presence combinations behave correctly; a deploy verb always prompts.

**P6 — Safety envelope.** Close the net-spend blind spot (host-allowlist classifier — non-baseline host → spend); attach-a-paid-tool carries `spend`; `SpendBudget` (ceiling + running total, denies when exhausted); four backstop levers (VETO/STEER/BATCH/KILL) + escalation-throttle circuit-breaker; **approval ledger** in every done packet, persisted; GLOBAL token+wall-clock+iteration budget bounding the loop and all nested guru-calls. *Accept:* YOLO still can't spend/destroy/touch-secrets (regression); non-baseline net → spend; $0 budget denies all spend; circuit-breaker pauses on N escalations; every mutation's packet has a persisted ledger; KILL aborts all workers.

**P7 — `runDevCycle` orchestrator + driver.** The state machine over 0–7; a `guru self-build --run` surface (+ `--dry-run` that prints discovered gates/commands and executes nothing); per-stage progress events; resume via session id; optional work-classification pause. *Accept:* one task driven end-to-end with git/gh/coderabbit ALL absent + a done packet; dry-run executes nothing; RED at review blocks ship; interrupted run resumes; halts at budget + on KILL.

## Safety envelope (threaded through every phase)
- **Spend is the one un-liftable hard gate** — `evaluate.ts` escalates hard edges before YOLO; P6 widens *what counts as spend* but never weakens it.
- **Every gate guru-native or discovered** — validation = the project's own scripts; review = the native panel; absence degrades to YELLOW, never RED-by-absence.
- **The constitution is preserved verbatim** — only its *inputs* become self-owned. No unattended self-improvement across a spend edge, ever.
- **Anti-rubber-stamp in code** — read-only critics, independent lenses, a separate repro-required VERIFY pass, majority-refute, GREEN only on empty CONFIRMED-high.
- **Bounded everything** — per-task timeout, bounded repair, swarm caps, a global token+wall-clock+iteration budget.
- **Matt's backstop = four legible levers over a persisted ledger** — VETO / STEER / BATCH (explicit ceiling, not the forbidden "always") / KILL + circuit-breaker.
- **Local-only durability** — change-record + audit ledger are real on-disk artifacts when git/Supabase are absent.

## The "replaces-the-builder" acceptance test
On a **fresh machine, only guru + one model key** — no CodeRabbit, no gh, one variant no git — `guru self-build --run` on this repo, unattended: SELECT (states why) → BUILD (real edits) → TEST (its *discovered* scripts) → SMOKE (self-call) → DEBUG (seeded-fixable repaired; seeded-unfixable bounded) → SELF-REVIEW (native panel catches a seeded bad diff as RED, passes a clean one, CodeRabbit never invoked) → SHIP (git→push, else on-disk record) → LEARN (one validated fact). A control task with a **spend verb hard-stops for approval even in YOLO**. Every mutation ships a done packet with validation + native-review evidence + a **persisted** approval ledger that survives a restart. **PASS = 1–8 unattended + 9 stops on spend + 10 survives restart, all with CodeRabbit/gh/(git) absent.**

## Open decisions for Matt
1. **Critic-panel size vs cost** — personas (default 4) + verifiers per finding; the worker cap + per-review token budget.
2. **Severity→verdict policy** — what's "high" (RED) vs "medium" (YELLOW); the single calibration knob.
3. **Single-model blind spot** — the native panel runs on the one baseline model (shares the author's blind spots). Accept, with CodeRabbit-when-present as the only independent cross-check — or authorize a SECOND provider for high-severity reviews (itself potential NEW spend → trips Law 3)?
4. **SpendBudget default** — $0 (every spend prompts) or a standing session ceiling as the BATCH default? And is an approved-but-mispriced op an acceptable residual risk (no rollback)?
5. **Work-classification** — all free changes fully autonomous, or force a human-checkpoint on sensitive classes (edits to `mandates/`, `safety/`, `config/`, or the review gate itself)?
6. **Local-only ship** — is an on-disk change-record acceptable delivery without version control, or must it refuse to "ship" without a VCS target?
7. **Cost-estimate honesty** — approve on "unknown cost", or auto-DENY unknown-cost ops until a cost can be derived?
