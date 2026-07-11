# Purpose

This AGENTS.md is the DOX contract for `\\STORAGE\projects\guruharness\main` — the active GuruHarness product tree (`guru` TUI + AgentSession SDK + `--mode rpc`).

# Ownership

- Matthew owns durable behavior and release policy for this scope.
- Agents may update this file when work changes local contracts, workflows, structure, or indexes.

# Local Contracts

- Treat this scope as the **active workspace**. Prefer fixing daily-driver breakage (TUI, composer, steer, chat loop) over theoretical hardening.
- Ignore `../archive/` and `../guru-web/` unless Matthew explicitly asks.
- Canonical git remote: `guru-dev` → `https://github.com/AutomationsGuru/guru-dev.git` (branch `main`). Do not reconcile with the superseded `GuruHarness` remote.
- Secrets: presence-over-value; never print keys; vault/env only.
- Review process: peer agent + CI (`repo-hygiene`, CodeQL). CodeRabbit is retired — see `../handoffs/REVIEW-PROCESS.md`.
- **Builder vs reviewer (Matthew 2026-07-09):** builder agents **code only** — implement, fix, update local files and handoff notes. Do **not** commit, push, open PRs, or drive GitHub Actions. The code-reviewer lane documents, cleans up, and pushes.

# Work Guidance

- Cold context: `../handoffs/CHECKPOINT-2026-07-10-usability-restore.md` then `CHECKPOINT-2026-07-10-usability-bugs.md` / this tree's `README.md` / `CHANGELOG.md`.
- Primary surfaces: `src/guru.ts`, `src/tui/*`, `src/session/agentSession.ts`, `src/model/agentTurn.ts`.
- Verify locally before claiming green: `npm run typecheck`, focused `npx vitest run tests/guru tests/tui` (build optional for local confidence; shipping is reviewer-owned).
- Keep durable plans/reports out of this drop-zone; handoffs live under `../handoffs/` or `R:\`.

# Verification

- AGENTS.md required-section check + Child DOX Index refresh after structural edits.
- `npm run typecheck` and relevant vitest suites must pass for TUI/composer changes.

## Child DOX Index

- `.claude\AGENTS.md`

(`src/`, `tests/`, `planning/`, `skills/` have no child docs and are governed by this contract)
