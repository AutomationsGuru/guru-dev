---
name: guruharness-self-build
description: Use when GuruHarness selects and executes its own bounded parity-building tasks.
allowed-tools: Read, Bash, Edit, Write, CodeRabbit
---

# GuruHarness Self-Build

Use this skill when executing a GuruHarness self-build task from `npm run cli -- self-build-plan`.

## Workflow

1. Resolve repository context and read the binding `AGENTS.md` chain.
2. Keep the change small, schema-first, and test-backed.
3. Update docs/decisions when future behavior changes.
4. Run validation commands from `guruharness.config.json`.
5. Run CodeRabbit before claiming GREEN.
6. Commit, push, open a PR, allow upstream gates to merge, and clean up the branch.

## Guardrails

- Never commit secrets, raw environment values, or Supabase `.temp` state.
- Never force-push or bypass branch protection.
- Stop with a YELLOW/RED done packet when validation or review gates block progress.
