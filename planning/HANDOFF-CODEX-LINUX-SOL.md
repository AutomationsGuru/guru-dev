# Handoff — Codex01 Linux builder · GuruHarness daily-driver + build lane

> Binding paired-build contract: WINDOWS-LINUX-PAIRED-BUILD.md. Do not begin a
> wave without its branch, exact SHA, scope, disjoint file ownership,
> acceptance commands, and known risks.

**Date:** 2026-07-10 (updated: CodeRabbit removed)  
**Audience:** Codex (or any agent) on the **Codex01 Linux build box**
**Windows counterpart:** Matthew daily-drives `guru` on Windows; Linux is the **big build + test + deep debug** machine.  
**Goal:** Get agents current, green, and useful for **test everything**, **debug**, and multi-file work on GuruHarness.

Read this first, then `README.md`, then the code map below. Do **not** invent a second remote history.

---

## 0. One-screen status

| Item | Value |
|------|--------|
| **Product** | GuruHarness — interactive agent harness CLI `guru` + SDK |
| **Maturity** | **pre-GA dogfood** — historical package versions are not daily-driver acceptance claims |
| **Package metadata** | Read `package.json`; do not bump it for routine work |
| **Canonical git remote** | `https://github.com/AutomationsGuru/guru-dev.git` — track as **`guru-dev`**, branch **`main`** |
| **Local dev CLI** | `npm run dev:install` — builds and links `guru` to this Linux checkout |
| **Published npm CLI** | `npm install -g guruharness@<released-version>` — release verification only |
| **Superseded remote** | `AutomationsGuru/GuruHarness` — **unrelated history. Never merge/reconcile.** |
| **Review SaaS** | **None.** CodeRabbit is **removed** from branch protection, config, and workflow. |

### Process (simple)

1. **Dev agent** implements and keeps `typecheck` / `build` / `test` green locally.
2. **Review agent** owns documentation cleanup, commits, pushes, code review, and PR handling.
3. A release owner creates a version/tag only after explicit dogfood acceptance; routine work stays `Unreleased`.

No CodeRabbit. No paid review bot. Peer-agent review is the gate before/with the PR.

---

## 1. Clone and bootstrap (Codex01 Linux)

```bash
node -v   # expect v22+
node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error("GuruHarness requires Node 22+"); process.exit(1); }'

wave_id="<wave-id>"
candidate_branch="<candidate-branch>"
candidate_sha="<candidate-sha>"
mkdir -p /home/codex/worktrees
git clone https://github.com/AutomationsGuru/guru-dev.git "/home/codex/worktrees/guruharness-$wave_id"
cd "/home/codex/worktrees/guruharness-$wave_id"
git remote rename origin guru-dev
git fetch --prune guru-dev "$candidate_branch"
test "$(git rev-parse FETCH_HEAD)" = "$candidate_sha" || exit 1
git checkout --detach "$candidate_sha"
test "$(git rev-parse HEAD)" = "$candidate_sha" || exit 1
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
the exact candidate branch/SHA under Node 22/24, then rerun this section. Do not
point the global `guru` link at the stale checkout.

**Dev CLI without a global link:** `node dist/guru.js` or `npx tsx src/guru.ts`.

---

## 2. Git / PR contract

- **Remote of record:** `guru-dev` → `AutomationsGuru/guru-dev`  
- **Builder flow:** local code/docs/tests only — no commit, push, PR, or release
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

## 4. Mission on Codex01 — test matrix

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

```bash
npm install -g "guruharness@<released-version>"
guru --version

# Resume source development afterwards.
cd /path/to/local/guruharness
npm run dev:install
```

Installing the published package replaces the local development link for that
Linux user. `npm run dev:install` restores the link when the next source cycle
starts.

### Live dogfood (optional with keys)

Connect a model, run a short tool-loop task, abort mid-turn once.

---

## 5. Paste-ready kickoff

> You are on the Codex01 Linux builder. Read `planning/WINDOWS-LINUX-PAIRED-BUILD.md` and `planning/HANDOFF-CODEX-LINUX-SOL.md`. Do not begin without a complete wave packet. Create a clean ext4 worktree under `/home/codex/worktrees` at the exact candidate branch/SHA; never use `AutomationsGuru/GuruHarness` or `/mnt/p` for npm execution. Run `npm ci && npm run typecheck && npm run build && npm test && npm run dev:install`; verify `guru --version`, the global link target, and the Linux PTY/TUI checklist. Keep work local: no commit, push, PR, publish, sudo npm link, or package-version bump. Report exact commands and PASS/FAIL against the candidate SHA.

---

## 6. Definition of done

- [ ] Clean ext4 worktree branch/SHA matches the wave packet
- [ ] Full hermetic suite green on that exact SHA
- [ ] `npm run dev:install` reports a global `guru` link to the local Linux clone
- [ ] Interactive TUI checklist written (terminal + pass/fail)  
- [ ] Reviewer handoff contains commands/results; no builder-side publish action
