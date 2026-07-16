# Planning (active)

Binding coordination and builder handoffs for the `guru-dev` product tree.

| Doc | Purpose |
| --- | --- |
| `WINDOWS-LINUX-PAIRED-BUILD.md` | Wave packets, lane ownership, candidate SHA rules |
| Active review handoffs | `../../handoffs/code-reviews/` — **`INDEX.md`** (PR #37 **merged** @ `6c826c6`; **PR #38** @ **`876e011`** · **PR #39** **`0013Z`** @ `9d63835`; recheck **`2349Z`**; doc-control pass-**532** · INDEX pass **529**) |
| Doc-control lane | `../../handoffs/doc-control/README.md` (post-merge wave · `0444Z`) · state `../../handoffs/doc-control/STATE.md` |
| Handoffs DOX | `../../handoffs/AGENTS.md` — workspace exchange contract (outside `main/`) |
| `HANDOFF-CODEX-LINUX-SOL.md` | Codex01 Linux builder cold start |
| `REVIEW-PROCESS.md` | Peer review + CI (mirror of `../../handoffs/REVIEW-PROCESS.md`) |
| `SELF-BUILD-*.md` | Self-build loop: **`SELF-BUILD-DEVELOPER-LOOP.md`** (P7 spine) · **`SELF-BUILD-LOOP-HARDENING.md`** (audit list + pass-350 reconciliation banner) · `SELF-BUILD-LOOP-GAP.md` (historical — superseded banner) |
| `../../gaps/README.md` | Scheduler gap-review index (indexed pass **181**; guru-vs-matrix pass **74**; harness-matrix pass **78**; **G1116**–**G1119** background/self-build; **G1108**–**G1115** plan/hooks/compaction/elicitation) |
| `../../handoffs/build-plans/README.md` | Linux gap implementation plans (indexed pass **150**; overlay **`1530Z`** incl. **G502**; **G681**/**G656**/**G627**/**G156** plans) |
| `../../handoffs/DOGFOOD-CHECKLIST-v1.5.0.md` | Daily-driver acceptance checklist (pre-GA); `npm run dogfood:portfolio` is orchestrator smoke only — not a substitute (G153) |

**Handoffs index:** `../../handoffs/README.md` (code-reviews · recheck **`2349Z`**; gaps pass **181**; guru-vs-matrix pass **74**; harness-matrix pass **78**). **Product README:** `../README.md` (product **`876e011`** · doc-control pass-**531**). **Doc-control:** pass-**532**; next **`guru-web/`** rotation.

**Main product DOX:** `../AGENTS.md` — paired-build contracts; post-merge via `INDEX.md` (`0444Z`). **`../CHANGELOG.md`** → `Unreleased` (PR #37 merged notes).

**Active assessments:** `../../handoffs/ASSESSMENT-2026-07-11-lane-fork-and-roadmap.md`, `../../handoffs/CHECKPOINT-2026-07-11-linux-reliability-wave.md`.

**Historical vision / gap corpus:** `../../archive/handoffs-history/vision-corpus/` · north-star acceptance **`../../archive/from-main/planning/THERE.md`** (no `THERE.md` in this folder). **Restore/as-is (THERE §15, gap G647):** schema freeze only — `../src/restore/manifests.ts` (FR-22); inventory writer D4.6 not shipped.

**Scheduler hubs (doc-control pass 532):** `../../gaps/README.md` pass **181** · guru-vs-matrix **74** · harness-matrix **78** · code-reviews INDEX **529** · recheck **`2349Z`** · PR #39 **`0013Z`**.

**Pi parity (historical scorecard — G103):** `../../archive/handoffs-history/pi-parity-checklist.md` (duplicate under `../../archive/requirements-corpus/requirements/pi-parity-checklist.md`) — baseline **Guru v0.8.2** / 654-row sheet; **not** authoritative for **1.5.x**. Live parity matrix: `../src/tools/toolParity.ts` (**23** GREEN / **4** YELLOW, pass **132**); daily-driver acceptance: `../../handoffs/DOGFOOD-CHECKLIST-v1.5.0.md`; gap index `../../gaps/README.md`.