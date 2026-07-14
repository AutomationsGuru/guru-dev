# Purpose

This AGENTS.md is the DOX contract for `\\STORAGE\projects\guruharness\main` — the active GuruHarness product tree (`guru` TUI + AgentSession SDK + `--mode rpc`).

# Ownership

- Matthew owns durable behavior and release policy for this scope.
- Agents may update this file when work changes local contracts, workflows, structure, or indexes.

# Local Contracts

- **Windows/Linux paired build:** follow planning/WINDOWS-LINUX-PAIRED-BUILD.md. Every wave requires a clean candidate branch and exact SHA, explicit scope, disjoint file ownership, acceptance commands, and known risks. A dirty or stale SHA mismatch stops Linux work; do not relink it. Only the same SHA green on Windows and Linux can advance to review and packaging gates.
- Treat this scope as the **active workspace**. Prefer fixing daily-driver breakage (TUI, composer, steer, chat loop) over theoretical hardening.
- **YOLO behavior:** routine workspace work must be directly executable in YOLO; do not retain ordinary approval prompts or executable allowlists that contradict that mode. Surface an unavailable integration honestly. Keep only clearly irreversible, billable, or credential/auth-affecting actions explicit unless Matthew reprioritizes that boundary.
- **Memory behavior:** Markdown fact memory (including its derived `MEMORY.md` index) is the default. PostgreSQL fact storage and Honcho context are optional, explicit integrations configured by environment-variable names; never report the Honcho test double as a live service.
- **Install/profile vs source/project:** `main/` is only the release source tree. Installed reusable state belongs in `~/.guruharness`; every launched target project gets a generated `<project>/.guru` harness. File-backed home assets (skills, garage, tools) are linked into that overlay, while its `guruharness.config.json` is seeded once from the home default and remains writable/project-specific. Native built-in tools are runtime code, not copied files.
- **Local developer install:** before handing off a runnable source-code change, run `npm run dev:sync`. It builds this checkout, refreshes its global npm link, and verifies that `guru` resolves here for local testing. The launcher accepts npm POSIX symlink and Windows shim entrypoints; smoke-test `guru --version` after relinking. This is a test handoff only: do not publish, commit, or push. A running Guru process must be restarted to load the refreshed build. On Linux, run it from a user-owned local filesystem clone with Node 22+ and a writable `npm root -g`; do not use `sudo npm link` or a CIFS/no-exec checkout.
- **Release maturity and versioning:** Guru is pre-GA dogfood regardless of historical published `1.x` package labels. A local build, test, install refresh, routine PR/push, or ordinary bug fix never changes `package.json` on its own; record the work under `CHANGELOG.md` → `Unreleased`. Because `1.x` is already public, a literal package-version reset or public migration needs an explicit release-owner plan; builders must not renumber or publish it. **Stay on `1.5.x` until Matthew is happy with how Guru works.** Patch numbers may climb without limit (`1.5.1`, `1.5.2`, …, even `1.5.99999` if needed). The current gated target is `1.5.1`. **`1.6.0` or higher is prohibited** until Matthew explicitly says Guru is working well enough to advance — enforced by `scripts/verify-repo.ps1` (CI) and the release workflow publish gate. After that acceptance, use SemVer strictly: patch = bug fixes, minor = coherent backward-compatible capability, major = breaking contract.
- `../guru-web/` is deliberately deferred. Do not spend product, design, testing, or planning effort there until the main GuruHarness is functionally complete and daily-driver reliable, unless Matthew explicitly reprioritizes it.
- Ignore `../archive/`; it is historical context only unless Matthew explicitly asks for it.
- Canonical git remote: `guru-dev` → `https://github.com/AutomationsGuru/guru-dev.git` (branch `main`). Do not reconcile with the superseded `GuruHarness` remote.
- Secrets: presence-over-value; never print keys; vault/env only.
- Review process: peer agent + CI (`repo-hygiene`, CodeQL). CodeRabbit is retired — see `../handoffs/REVIEW-PROCESS.md`.
- **Builder vs reviewer (Matthew 2026-07-09):** builder agents **code only** — implement, fix, update local files and handoff notes. Do **not** commit, push, open PRs, or drive GitHub Actions. The code-reviewer lane documents, cleans up, and pushes.

# Work Guidance

- Cold context: `../handoffs/ASSESSMENT-2026-07-11-lane-fork-and-roadmap.md` then `CHECKPOINT-2026-07-11-linux-reliability-wave.md` / this tree's `README.md` / `CHANGELOG.md`.
- Primary surfaces: `src/guru.ts`, `src/tui/*`, `src/session/agentSession.ts`, `src/model/agentTurn.ts`.
- Verify locally before claiming green: `npm run typecheck`, focused `npx vitest run tests/guru tests/tui` (build optional for local confidence; shipping is reviewer-owned).
- Keep durable plans/reports out of this drop-zone; handoffs live under `../handoffs/` or `R:\`.

# Verification

- AGENTS.md required-section check + Child DOX Index refresh after structural edits.
- `npm run typecheck` and relevant vitest suites must pass for TUI/composer changes.

## Child DOX Index

- `.claude\AGENTS.md`

(`src/`, `tests/`, `planning/`, `skills/` have no child docs and are governed by this contract)
