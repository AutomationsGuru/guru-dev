# Changelog

All notable changes to GuruHarness are documented here.

## [0.1.0] - 2026-06-17

Release-prep status: artifacts prepared only; no tag or release has been cut.

### Added

- Repo-aware TypeScript harness foundation with normalized result contracts and done packets.
- Bounded self-build loop with HERE/THERE direction checks and task dependency ordering.
- Schema-first configuration loading, typed tool registry, and runtime skill loading.
- Repo context and AGENTS.md chain discovery for target repositories.
- Validation, CodeRabbit, git/PR automation, and repository hygiene gates.
- Supabase-backed operational store for projects, state snapshots, decisions, backlog, implementations, configurations, and endpoints.
- Harness runtime sessions with planner execution, resumable persistence, CLI `run`, API, and TUI surfaces.
- OpenAI-compatible planner model adapter with credential lookup by environment variable name only.
- Runtime hardening for secret detection, risky path blocking, fallback planning, explicit resume misses, and API safety override controls.
- Provider fallback playbook, long-running observability timelines, and operator recovery actions.
- Dry-run-first file, shell, GitHub PR, and operational-store runtime tools.
- One-shot CLI/API `tool-run` surface with cross-shell path normalization for known path fields.
- Reusable portfolio dogfood smoke covering core, Sentry, Beeper, CyberChef, and code-paste-and-go representative orchestrators.

### Changed

- Expanded dogfood coverage from current-repo smoke tests to local and opt-in remote tier-2 real-repo checks.
- Consolidated dogfood roster construction behind a small shared orchestrator interface.
- Documented end-to-end dogfood, phase-4 real-repo coverage, cross-repo portfolio analysis, tier-2 coverage, and multi-orchestrator consolidation findings.

### Fixed

- Google Drive temporary sync artifacts are ignored.
- Skill loader migration config kind was corrected.
- MSYS/Git Bash `/c/...` paths are normalized for explicit tool-run path fields without rewriting arbitrary text fields.

### Validation

Release-prep branch validation evidence is captured in `docs/releases/v0.1.0.md`.
