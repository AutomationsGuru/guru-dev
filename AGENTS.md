# Purpose

DOX contract for `main/` — the active GuruHarness product tree (`guru` TUI, AgentSession SDK, `--mode rpc`).

**Inherits** project rail: [`../AGENTS.md`](../AGENTS.md). Do not restate global DOX, secrets, or fleet rules here.

# Ownership

- Matthew owns durable product behavior and release advancement past 1.5.x.
- Agents may update this file when product contracts, surfaces, or verification change.

# Local Contracts

- **Active workspace:** prefer daily-driver reliability (TUI, composer, steer, chat loop) over speculative breadth.
- **Linux-first:** follow `planning/WINDOWS-LINUX-PAIRED-BUILD.md`. Platform-neutral code lands on Linux; Windows owns Windows-specific fixes and same-SHA daily-driver validation.
- **Wave identity:** implementation from a clean exact base SHA (review-red only for bounded corrective scope). Validation requires a clean exact candidate SHA. Dirty/stale SHA mismatch stops the wave.
- **YOLO:** routine workspace work must be directly executable in YOLO. Surface unavailable integrations honestly. Keep irreversible, billable, or credential/auth-affecting actions explicit.
- **Memory:** Markdown fact memory (and derived `MEMORY.md`) is default. PostgreSQL facts and Honcho are optional env-configured integrations — never report the Honcho test double as live.
- **Install vs source:** `main/` is release source only. Installed state: `~/.guruharness`. Per project: generated `<project>/.guru`. File-backed home assets link into the overlay; `guruharness.config.json` is project-writable.
- **Local developer install:** before a runnable source handoff, `npm run dev:sync` (build + global link + `guru --version`). Node 22+; user-owned local FS clone; no `sudo npm link`; not CIFS/no-exec. Restart running Guru to load the build. Not a publish step.
- **Published npm:** coordinated exact-version install only after release evidence — see root rail.
- **Version:** stay **1.5.x** until Matthew authorizes higher. Routine work → `CHANGELOG.md` → `Unreleased`. Package line as of 2026-07-18: **1.5.2**.
- **Deferred:** `../guru-web/` — no product effort until Matthew reprioritizes.
- **Ignore** `../archive/` unless Matthew asks.
- **Remote:** `guru-dev` → `https://github.com/AutomationsGuru/guru-dev.git` (`main`).
- **Secrets:** presence-over-value; never print keys.
- **Code-review exchange:** `../handoffs/code-reviews/` (`INDEX.md`). Newest applicable verdict controls. Builders implement; do not edit verdict files.
- **Builder vs reviewer:** builders code + evidence only (no commit/push/PR). Code-reviewer owns publish. Pipeline/merge lanes may approve/merge green candidates per root rail.

# Work Guidance

- Cold start: `README.md`, `CHANGELOG.md`, `../handoffs/README.md`, `../handoffs/build-plans/README.md`, `../handoffs/code-reviews/INDEX.md`.
- Doc-control / gaps / matrix: `../handoffs/doc-control/`, `../gaps/README.md`, `../handoffs/harness-matrix/README.md`.
- Primary surfaces: `src/guru.ts`, `src/tui/*`, `src/session/agentSession.ts`, `src/model/agentTurn.ts`, `src/memory/`, `src/guru/memorySessionService.ts`.
- Linux: typecheck, build, full/focused tests, PTY/TUI. Windows: same-SHA automated checks + Terminal/daily-driver before cross-platform green claims.
- Durable plans/reports: `../handoffs/` or org storage — not inside this drop-zone as orphan artifacts.

# Verification

- After DOX edits: required sections + Child DOX Index.
- Product changes: `npm run typecheck` and relevant vitest suites (TUI/composer focused suites as applicable).

# Child DOX Index

- `.claude/AGENTS.md` — thin pointer to this file + root
- `planning/README.md` — paired-build, handoffs, review process mirrors
- `skills/README.md` — bundled skills index
- `tests/README.md` — vitest layout

(`src/` has no child AGENTS.md; module headers apply under this contract.)
