# Purpose

LHT Panel Status feature — Long Horizon Tracker completion-gate visibility in TUI (idea-f172, G1055).

# Ownership

- Product: Matthew owns LHT panel behavior and TUI integration.
- Implementation: Builders implement per this contract and parent DOX.

# Local Contracts

- Config-driven options for LHT panel (disabled-by-default, non-intrusive).
- Runtime lifecycle integration (start/stop/status hooks).
- CLI commands for LHT control.
- TUI panel for status display.
- State persistence for panel data.
- Extends donePacket.ts: Session metrics extraction, gate completion, compaction-safe persistence.
- Integrates with mandates/evaluate.ts: Net-spend delta from G1055 classifier.
- Health states: `healthy` | `stall` | `complete`.
- Gates format: X/Y passed/pending counts.
- Persistence: LhtStateSnapshot for compaction boundaries.

# Work Guidance

- Follow G1055 build plan: config options, runtime lifecycle, CLI commands, TUI panel, state persistence.
- Schema-first: Define Zod schemas in `schemas.ts` before implementation.
- Tracker pattern: `LhtTracker` class with callback-based event notifications.
- Integration layer: Use `engine.ts` for donePacket/G1055 bridging.
- TUI panel: `panel.ts` for status display; compaction in `compaction.ts`.
- Prefer minimal, reversible changes; preserve existing TUI/CLI behavior.
- Validation: typecheck, vitest, smoke tests.

# Verification

- typecheck
- vitest
- smoke tests

# Child DOX Index

- `schemas.ts` — Zod schemas, TypeScript interfaces, helper functions.
- `engine.ts` — Core LhtTracker and runtime integration.
- `panel.ts` — TUI panel renderer and queries.
- `compaction.ts` — State snapshot and compaction boundaries.
- `index.ts` — Public module exports.
