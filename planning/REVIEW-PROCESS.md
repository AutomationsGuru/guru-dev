# Review process (post–CodeRabbit)

**Effective:** 2026-07-10  
CodeRabbit (SaaS bot + required GitHub check + `.coderabbit.yaml`) is **removed**. Do not reinstall it.

## Flow

1. **Dev agent** — implement on a feature branch; keep local green:
   - `npm run typecheck`
   - `npm run build`
   - `npm test` (or focused vitest for the surface)
2. **Review agent** — separate agent/session reviews the diff (correctness, regressions, secrets, scope). Fix findings on the same branch.
3. **PR** — open against `guru-dev/main`. CI must pass (`repo-hygiene`, CodeQL). Merge when green.

No paid review bot. Matthew does not hand-review routine PRs.

## Harness config

- Default `reviewGate.provider` = **`native-critic-panel`** (guru-native, optional model panel).
- Optional `provider: "command"` + `command: [...]` for a local CLI gate only.
- The `coderabbit` provider enum value is **rejected** by schema.

## Branch protection

- Required status check: **`repo-hygiene` only**
- No required CodeRabbit check
- No required GitHub approving reviews (peer review is process, not a bot)

## Do not

- Add `.coderabbit.yaml` or CodeRabbit app checks back
- Block merges on external review SaaS
- Put AI co-author trailers on commits/PRs
