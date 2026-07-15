# Planning (active)

Binding coordination and builder handoffs for the `guru-dev` product tree.

| Doc | Purpose |
| --- | --- |
| `WINDOWS-LINUX-PAIRED-BUILD.md` | Wave packets, lane ownership, candidate SHA rules |
| Active review handoffs | `../../handoffs/code-reviews/` — **`INDEX.md`** (PR #37 **merged** · idle `0830Z` @ `6c826c6`; append-only history) |
| Doc-control lane | `../../handoffs/doc-control/README.md` (post-merge wave · `0444Z`) · state `../../handoffs/doc-control/STATE.md` |
| Handoffs DOX | `../../handoffs/AGENTS.md` — workspace exchange contract (outside `main/`) |
| `HANDOFF-CODEX-LINUX-SOL.md` | Codex01 Linux builder cold start |
| `REVIEW-PROCESS.md` | Peer review + CI (mirror of `../../handoffs/REVIEW-PROCESS.md`) |
| `SELF-BUILD-*.md` | Self-build loop: **`SELF-BUILD-DEVELOPER-LOOP.md`** (P7 spine) · **`SELF-BUILD-LOOP-HARDENING.md`** (audit list + pass-350 reconciliation banner) · `SELF-BUILD-LOOP-GAP.md` (historical — superseded banner) |
| `../../gaps/README.md` | Scheduler gap-review index (indexed pass **68** — e.g. G8/G225, G26/G277, G52, G121, G191, G253, G281) |
| `../../handoffs/DOGFOOD-CHECKLIST-v1.5.0.md` | Daily-driver acceptance checklist (pre-GA); `npm run dogfood:portfolio` is orchestrator smoke only — not a substitute (G153) |

**Handoffs index:** `../../handoffs/README.md` (code-reviews · **merged** `0444Z`, harness-matrix pass **02**, assessments). **Product README:** `../README.md` (Development → handoffs + doc-control `STATE.md`).

**Main product DOX:** `../AGENTS.md` — paired-build contracts; post-merge via `INDEX.md` (`0444Z`). **`../CHANGELOG.md`** → `Unreleased` (PR #37 merged notes).

**Active assessments:** `../../handoffs/ASSESSMENT-2026-07-11-lane-fork-and-roadmap.md`, `../../handoffs/CHECKPOINT-2026-07-11-linux-reliability-wave.md`.

**Historical vision / gap corpus:** `../../archive/handoffs-history/vision-corpus/` · north-star acceptance **`../../archive/from-main/planning/THERE.md`** (no `THERE.md` in this folder).

**Pi parity (historical scorecard — G103):** `../../archive/handoffs-history/pi-parity-checklist.md` (duplicate under `../../archive/requirements-corpus/requirements/pi-parity-checklist.md`) — baseline **Guru v0.8.2** / 654-row sheet; **not** authoritative for **1.5.x**. Live parity matrix: `../src/tools/toolParity.ts`; daily-driver acceptance: `../../handoffs/DOGFOOD-CHECKLIST-v1.5.0.md`; gap index `../../gaps/README.md`.