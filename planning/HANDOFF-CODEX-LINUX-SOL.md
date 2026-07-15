# Handoff — Codex01 Linux builder · GuruHarness daily-driver + build lane

> Binding paired-build contract: WINDOWS-LINUX-PAIRED-BUILD.md. An
> implementation wave requires an exact clean base SHA; a validation wave
> requires an exact clean candidate SHA. Both require scope, disjoint file
> ownership, acceptance commands, and known risks.

**Date:** 2026-07-10 (updated 2026-07-14: Linux-first construction)
**Audience:** Codex (or any agent) on the **Codex01 Linux build box**
**Windows counterpart:** Matthew daily-drives `guru` on Windows; Windows owns Windows-specific fixes and Windows acceptance.
**Goal:** Make Codex01 the primary **implementation + build + test + deep debug** machine for GuruHarness, using its workers, sub-agents, and other harnesses where useful.

Read this first, then `README.md` (this planning index), `../README.md` (product), then the code map below. Active PR reviews: `../../handoffs/code-reviews/INDEX.md`. Do **not** invent a second remote history.

---

## 0. One-screen status

| Item | Value |
|------|--------|
| **Product** | GuruHarness — interactive agent harness CLI `guru` + SDK |
| **Maturity** | **pre-GA dogfood** — historical package versions are not daily-driver acceptance claims |
| **Package metadata** | Read `package.json`; do not bump it for routine work |
| **Canonical git remote** | `https://github.com/AutomationsGuru/guru-dev.git` — track as **`guru-dev`**, branch **`main`** |
| **Local dev CLI** | `npm run dev:install` — builds and links `guru` to this Linux checkout |
| **Published npm CLI** | `npm install -g guruharness@<released-version>` — coordinated package-install wave only |
| **Superseded remote** | `AutomationsGuru/GuruHarness` — **unrelated history. Never merge/reconcile.** |
| **Review SaaS** | **None.** CodeRabbit is **removed** from branch protection, config, and workflow. |

### Process (simple)

1. **Linux dev agents** own platform-neutral implementation and keep focused plus full checks green locally.
2. **Review agent on Codex01** reviews the preserved ext4 worktree, owns documentation cleanup, commits, pushes, and PR handling, then emits an exact candidate SHA.
3. **Windows** coordinates quality state and exact candidate/release identity, validates the same SHA through Windows checks, `dev:sync`, Windows Terminal, and daily-driver use, and implements only Windows-specific fixes.
4. A release owner creates a version/tag only after explicit dogfood acceptance; routine work stays `Unreleased`.

No CodeRabbit. No paid review bot. Peer-agent review is the gate before/with the PR.

---

## 1. Clone and bootstrap (Codex01 Linux)

```bash
node -v   # expect v22+
node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error("GuruHarness requires Node 22+"); process.exit(1); }'

wave_id="<wave-id>"
wave_phase="<implementation-or-validation>"
source_branch="<base-or-candidate-branch>"
source_sha="<full-base-or-candidate-sha>"
mkdir -p /home/codex/worktrees
git clone https://github.com/AutomationsGuru/guru-dev.git "/home/codex/worktrees/guruharness-$wave_id"
cd "/home/codex/worktrees/guruharness-$wave_id"
git remote rename origin guru-dev
git fetch --prune guru-dev "$source_branch"
test "$(git rev-parse FETCH_HEAD)" = "$source_sha" || exit 1
git checkout --detach "$source_sha"
test "$(git rev-parse HEAD)" = "$source_sha" || exit 1
test -z "$(git status --porcelain)" || exit 1

# The local-link workflow is present only in the current source state.
node -e 'const { scripts = {} } = require("./package.json"); for (const name of ["dev:install", "dev:sync"]) if (!scripts[name]) throw new Error(name + " missing: refresh this worktree from the wave candidate branch/SHA");'

npm ci
npm run typecheck
npm run build
npm test

# Local development CLI: build, globally link, then verify `guru` resolves here.
test -w "$(npm root -g)" || {
  echo "Use the builder's user-owned Node/npm installation; do not use sudo npm link."
  exit 1
}
npm run dev:install
guru --version
```

Run this from a local Linux filesystem clone, not the `/mnt/p` CIFS/no-exec
mount. Native npm binaries cannot execute reliably from that shared mount.
The global package is a Linux symlink to this checkout, so after every runnable
source-code change run `npm run dev:sync`, restart Guru, and dogfood the new
build. Never use `sudo npm link`; a user-owned Node 22+ installation is the
correct fix for a root-owned global npm directory.

If the Node gate or either `dev:*` script check fails, this is a stale clone or
toolchain—not an npm-link failure. Stop, recreate the clean ext4 worktree from
the exact wave source branch/SHA under Node 22/24, then rerun this section. Do
not point the global `guru` link at the stale checkout. An implementation phase
may then edit its verified base; a validation phase must stay clean at the
candidate SHA.

**Dev CLI without a global link:** `node dist/guru.js` or `npx tsx src/guru.ts`.

---

## 2. Git / PR contract

- **Remote of record:** `guru-dev` → `AutomationsGuru/guru-dev`
- **Builder flow:** Linux-first local code/tests and handoff evidence — no commit, push, PR, or release
- **Reviewer flow:** author, commit, push, peer review, and PR after the local handoff is ready
- **Required check:** `repo-hygiene` (plus CodeQL as available)
- **Not required:** CodeRabbit, paid bots, human Matthew hand-review
- **Release:** a deliberate reviewer/owner action after dogfood acceptance; version/tag must match package metadata, then GitHub release + `npm publish` ships it

Secrets: presence-over-value; never print keys.

---

## 3. What to read (in order)

1. **This handoff**
2. `README.md`
3. `CHANGELOG.md`
4. Code roots: `src/guru.ts`, `src/tui/*`, `src/model/*`, `src/mandates/*`, `src/selfbuild/*`, `tests/**`

Review gate default: **`native-critic-panel`** in `guruharness.config.json` (guru's own critic — not an external SaaS).

---

## 4. Mission on Codex01 — implementation and test matrix

Platform-neutral implementation belongs here by default. Partition substantive
work across available Codex workers or other harnesses only when file ownership
is explicit and non-overlapping. Read-only scouts and critics may run in
parallel; dependent edit lanes run in dependency order. Preserve the ext4
worktree for the reviewer instead of moving implementation back to Windows.

### Hermetic

```bash
npm run typecheck && npm run build && npm test
```

### Linux interactive TUI (parity with Windows)

```bash
guru
```

Confirm: splash version, YOLO banner, **typing does not stack a line per keystroke**, backspace/arrows, `/help` `/model`, interrupt.

### Published-package round trip (only after a release exists)

Do not install a newly published version independently. Wait for the Windows
quality controller's package-install packet containing the exact released
version and npm registry identity. Acknowledge a safe install window so an
active build or development link is not silently disrupted.

```bash
version="<exact-released-version>"
npm view "guruharness@$version" version dist.integrity gitHead
npm install -g "guruharness@$version"
guru --version
npm list -g guruharness --depth=0

# After reporting the package result, resume source development if needed.
cd /path/to/local/guruharness
npm run dev:install
git rev-parse HEAD
```

Installing the published package replaces the local development link for that
Linux user. Report the package smoke before restoring anything. If
`npm run dev:install` restores the source link for continued building, report
the resolved worktree path and exact SHA so Windows retains the true
cross-platform state. Windows installs the same exact package only after the
Linux package smoke passes.

### Live dogfood (optional with keys)

Connect a model, run a short tool-loop task, abort mid-turn once.

---

## 5. Paste-ready kickoff

> You are on the Codex01 Linux-first builder. Read `planning/WINDOWS-LINUX-PAIRED-BUILD.md`, `planning/HANDOFF-CODEX-LINUX-SOL.md`, and the newest applicable code-review report. Do not begin without a complete wave packet. For implementation, create a clean ext4 worktree under `/home/codex/worktrees` at the exact base SHA, then perform the platform-neutral work with non-overlapping worker ownership. For validation, use the exact clean candidate SHA. Never use `AutomationsGuru/GuruHarness` or `/mnt/p` for npm execution. Run focused checks plus `npm run typecheck && npm run build && npm test && npm run dev:install`; verify `guru --version`, the global link target, and Linux PTY/TUI behavior. Keep builder work local: no commit, push, PR, publish, sudo npm link, or package-version bump. Preserve the worktree for the reviewer and report exact commands and PASS/FAIL.

---

## 6. Definition of done

- [ ] Clean ext4 worktree source branch/SHA matches the wave packet before edits or validation
- [ ] Assigned implementation is complete with non-overlapping ownership and focused tests green
- [ ] Full hermetic suite green on the resulting worktree or exact validation candidate
- [ ] `npm run dev:install` reports a global `guru` link to the local Linux clone
- [ ] Interactive TUI checklist written (terminal + pass/fail)
- [ ] Reviewer handoff contains base/candidate identity, commands, results, and preserved worktree path; no builder-side publish action
