---
name: guruharness-self-build
description: Use when GuruHarness selects and executes its own bounded parity-building tasks.
allowed-tools: Read, Bash, Edit, Write
---

# GuruHarness Self-Build

Use this skill when executing a GuruHarness self-build task from `npm run cli -- self-build-plan`.

## Workflow

1. Resolve repository context and read the binding `AGENTS.md` chain.
2. Keep the change small, schema-first, and test-backed.
3. Update docs/decisions when future behavior changes.
4. Run validation commands from `guruharness.config.json`.
5. Peer agent code review (or native critic panel) before claiming GREEN — **no CodeRabbit** (see `../../planning/SELF-BUILD-DEVELOPER-LOOP.md`).
6. **Workspace builder lanes:** local edits + evidence in `../../handoffs/code-reviews/` only — no commit/push/PR (reviewer lane publishes). **Release owner** commits, pushes, opens PR, waits for CI (`repo-hygiene` + CodeQL), merges.

## Guardrails

- Never commit secrets, raw environment values, or Supabase `.temp` state.
- Never force-push or bypass branch protection.
- Stop with a YELLOW/RED done packet when validation or review gates block progress.
