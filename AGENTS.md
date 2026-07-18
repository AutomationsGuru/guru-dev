# Purpose

This AGENTS.md is the DOX contract for `\\STORAGE\projects\guruharness\main` — the active GuruHarness product tree (`guru` TUI + AgentSession SDK + `--mode rpc`).

# Ownership

- Matthew owns durable behavior and release policy for this scope.
- Agents may update this file when work changes local contracts, workflows, structure, or indexes.

# Local Contracts

- **Linux-first paired build:** follow planning/WINDOWS-LINUX-PAIRED-BUILD.md. Codex01 owns platform-neutral implementation, refactors, deep debugging, primary automated tests, PTY/TUI work, and parallel agent/harness execution. Windows owns quality coordination, review/handoff state, exact candidate/release identity, Windows-specific fixes, Windows Terminal, and installed daily-driver validation; do not duplicate Linux build work here.
- **Wave identity:** an implementation wave starts from a clean exact base branch/SHA and may use a review-red SHA when its scope is corrective. A validation wave requires a clean exact candidate branch/SHA. Every wave also requires explicit scope, disjoint file ownership, acceptance commands, and known risks. A dirty or stale SHA mismatch stops the wave. Only the same candidate SHA green on Windows and Linux can advance to packaging and release gates.
- Treat this scope as the **active workspace**. Prefer fixing daily-driver breakage (TUI, composer, steer, chat loop) over theoretical hardening.
- **YOLO behavior:** routine workspace work must be directly executable in YOLO; do not retain ordinary approval prompts or executable allowlists that contradict that mode. Surface an unavailable integration honestly. Keep only clearly irreversible, billable, or credential/auth-affecting actions explicit unless Matthew reprioritizes that boundary.
- **Memory behavior:** Markdown fact memory (including its derived `MEMORY.md` index) is the default. PostgreSQL fact storage and Honcho context are optional, explicit integrations configured by environment-variable names; never report the Honcho test double as a live service.
- **Install/profile vs source/project:** `main/` is only the release source tree. Installed reusable state belongs in `~/.guruharness`; every launched target project gets a generated `<project>/.guru` harness. File-backed home assets (skills, garage, tools) are linked into that overlay, while its `guruharness.config.json` is seeded once from the home default and remains writable/project-specific. Native built-in tools are runtime code, not copied files.
- **Local developer install:** before handing off a runnable source-code change, run `npm run dev:sync`. It builds this checkout, refreshes its global npm link, and verifies that `guru` resolves here for local testing. The launcher accepts npm POSIX symlink and Windows shim entrypoints; smoke-test `guru --version` after relinking. This is a test handoff only: do not publish, commit, or push. A running Guru process must be restarted to load the refreshed build. On Linux, run it from a user-owned local filesystem clone with Node 22+ and a writable `npm root -g`; do not use `sudo npm link` or a CIFS/no-exec checkout.
- **Published npm synchronization:** neither platform installs a new published GuruHarness version independently. After an explicit released handoff, Windows resolves the exact 1.5.x version and npm package identity, sends Linux a package-install packet, and waits for Linux's exact-version package smoke. Windows then installs and verifies that same version. Both platforms report `guru --version`, global npm package/link state, and smoke results. Linux may restore its active source link after the package test, but must report the restored worktree and SHA.
- **Release maturity and versioning:** Guru is pre-GA dogfood regardless of historical published `1.x` package labels. A local build, test, install refresh, routine PR/push, or ordinary bug fix never changes `package.json` on its own; record the work under `CHANGELOG.md` → `Unreleased`. Because `1.x` is already public, a literal package-version reset or public migration needs an explicit release-owner plan; builders must not renumber or publish it. **Stay on `1.5.x` until Matthew is happy with how Guru works.** Patch numbers may climb without limit (`1.5.1`, `1.5.2`, …, even `1.5.99999` if needed). Package line is `1.5.2` (2026-07-18); next gated patch target is `1.5.3`. **`1.6.0` or higher is prohibited** until Matthew explicitly says Guru is working well enough to advance — enforced by `scripts/verify-repo.ps1` (CI) and the release workflow publish gate. After that acceptance, use SemVer strictly: patch = bug fixes, minor = coherent backward-compatible capability, major = breaking contract.
- `../guru-web/` is deliberately deferred. Do not spend product, design, testing, or planning effort there until the main GuruHarness is functionally complete and daily-driver reliable, unless Matthew explicitly reprioritizes it.
- Ignore `../archive/`; it is historical context only unless Matthew explicitly asks for it.
- Canonical git remote: `guru-dev` → `https://github.com/AutomationsGuru/guru-dev.git` (branch `main`). Do not reconcile with the superseded `GuruHarness` remote.
- Secrets: presence-over-value; never print keys; vault/env only.
- **Code-review exchange:** `../handoffs/code-reviews/` is the canonical builder/reviewer handoff folder (`INDEX.md` for navigation). Builders address the newest applicable verdict without editing verdict files; any red or changes-required verdict blocks merge, GitHub main promotion, and npm publishing until cleared for the candidate SHA.
- Review process: peer agent + CI (`repo-hygiene`, CodeQL). CodeRabbit is retired — see `../handoffs/REVIEW-PROCESS.md`.
- **Builder vs reviewer (Matthew 2026-07-09):** builder agents **code only** — implement, fix, update local files and place evidence in `../handoffs/code-reviews/`. Do **not** commit, push, open PRs, or drive GitHub Actions unless the pipeline-gate mandate below applies. The code-reviewer lane owns verdicts, documentation cleanup, commits, pushes, PR handling, and gated release publication.
- **Pipeline gate (Matthew 2026-07-16):** scheduled review/sync/merge/unblock lanes and the code-reviewer path **act as the human** for GitHub: when CI is green and content is approved, **approve, merge, close non-candidates, rebase/fix-merge only when necessary to keep the pipeline moving**. Do not leave green candidates stuck waiting for Matthew. Still stay **1.5.x** and do not npm-publish without release gates.

# Work Guidance

- Cold context: `../handoffs/ASSESSMENT-2026-07-11-lane-fork-and-roadmap.md` then `CHECKPOINT-2026-07-11-linux-reliability-wave.md` / this tree's `README.md` / `CHANGELOG.md`.
- Workspace **doc-control:** `../handoffs/doc-control/STATE.md` · lane index `../handoffs/doc-control/README.md` · planning `planning/README.md` · doc-vs-built gaps `../gaps/README.md` (indexed pass **181**; guru-vs-matrix pass **74**, scheduler `019f64f0454b`) · harness matrix `../handoffs/harness-matrix/README.md` (pass **77**); doc-control pass-**531**.
- **Post-merge:** PR #37 @ `6c826c6` · PR #38 @ **`876e011`** · PR #39 **MERGED** → `main` @ **`516d1c7`** (`0222Z-pr39-merged-integrated`); snapshot #40/#41 closed. See `../handoffs/code-reviews/INDEX.md`. npm publish still gated on 1.5.x release discipline.
- Primary surfaces: `src/guru.ts`, `src/tui/*`, `src/session/agentSession.ts`, `src/model/agentTurn.ts`, `src/memory/` (L1/L2 facts + scopes; session wiring `src/guru/memorySessionService.ts`).
- Linux runs the primary typecheck, build, full/focused tests, and PTY/TUI checks. Windows repeats the relevant automated checks on the exact candidate, runs `npm run dev:sync`, and performs Windows Terminal/daily-driver validation before claiming cross-platform green.
- Windows monitors Linux progress, the controlling code-review handoff, candidate parity, and coordinated npm release installation; it routes quality failures to Linux unless evidence proves they are Windows-specific.
- Keep durable plans/reports out of this drop-zone; handoffs live under `../handoffs/` or `R:\`.

# Verification

- AGENTS.md required-section check + Child DOX Index refresh after structural edits.
- `npm run typecheck` and relevant vitest suites must pass for TUI/composer changes.

## Child DOX Index

- `.claude\AGENTS.md`
- `planning\README.md` — active planning index (paired-build, HANDOFF, REVIEW-PROCESS mirror)
- `skills\README.md` — bundled skill packages index
- `tests\README.md` — vitest layout and fixture paths (doc index)

(`src/` has no child `AGENTS.md`; governed by this contract. Module headers: `src/memory/` doc-control pass-370. Workspace: `../handoffs/README.md` · doc-vs-built gaps `../gaps/README.md` (pass **181** / guru-vs **74** / matrix **77**).)
