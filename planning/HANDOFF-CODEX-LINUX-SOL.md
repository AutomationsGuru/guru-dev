# Handoff — Codex on Linux (Sol) · GuruHarness daily-driver + build lane

**Date:** 2026-07-10 (updated: CodeRabbit removed)  
**Audience:** Codex (or any agent) on the **Sol / Linux build box**  
**Windows counterpart:** Matthew daily-drives `guru` on Windows; Linux is the **big build + test + deep debug** machine.  
**Goal:** Get agents current, green, and useful for **test everything**, **debug**, and multi-file work on GuruHarness.

Read this first, then `README.md`, then the code map below. Do **not** invent a second remote history.

---

## 0. One-screen status

| Item | Value |
|------|--------|
| **Product** | GuruHarness — interactive agent harness CLI `guru` + SDK |
| **Version** | **1.4.1+** (`package.json`, npm `guruharness`) |
| **Canonical git remote** | `https://github.com/AutomationsGuru/guru-dev.git` — track as **`guru-dev`**, branch **`main`** |
| **npm** | `npm install -g guruharness` |
| **Superseded remote** | `AutomationsGuru/GuruHarness` — **unrelated history. Never merge/reconcile.** |
| **Review SaaS** | **None.** CodeRabbit is **removed** from branch protection, config, and workflow. |

### Process (simple)

1. **Dev agent** implements + keeps `typecheck` / `build` / `test` green.  
2. **Review agent** (different session/agent) does code review on the branch/diff.  
3. **PR** when ready → CI (`repo-hygiene` + CodeQL) → merge.  

No CodeRabbit. No paid review bot. Peer-agent review is the gate before/with the PR.

---

## 1. Clone and bootstrap (Linux / Sol)

```bash
node -v   # expect v22+

git clone https://github.com/AutomationsGuru/guru-dev.git guruharness
cd guruharness
git fetch --tags
git checkout main
git pull

npm ci
npm run typecheck
npm run build
npm test

npm install -g guruharness   # optional global CLI
guru --version
```

**Dev CLI without global install:** `node dist/guru.js` or `npx tsx src/guru.ts`.

---

## 2. Git / PR contract

- **Remote of record:** `guru-dev` → `AutomationsGuru/guru-dev`  
- **Author:** `AutomationsGuru <matt@automations.guru>` only — **no** AI co-author trailers  
- **Flow:** branch → **peer agent review** → PR → CI green → **merge**  
- **Required check:** `repo-hygiene` (plus CodeQL as available)  
- **Not required:** CodeRabbit, paid bots, human Matthew hand-review  
- **Release:** bump package + lock → README badge → PR → tag → GitHub release + `npm publish` when shipping a version  

Secrets: presence-over-value; never print keys.

---

## 3. What to read (in order)

1. **This handoff**  
2. `README.md`  
3. `CHANGELOG.md`  
4. Code roots: `src/guru.ts`, `src/tui/*`, `src/model/*`, `src/mandates/*`, `src/selfbuild/*`, `tests/**`  

Review gate default: **`native-critic-panel`** in `guruharness.config.json` (guru's own critic — not an external SaaS).

---

## 4. Mission on Sol — test matrix

### Hermetic

```bash
npm run typecheck && npm run build && npm test
```

### Linux interactive TUI (parity with Windows)

```bash
guru
```

Confirm: splash version, YOLO banner, **typing does not stack a line per keystroke**, backspace/arrows, `/help` `/model`, interrupt.

### Live dogfood (optional with keys)

Connect a model, run a short tool-loop task, abort mid-turn once.

---

## 5. Paste-ready kickoff

> You are on the Sol Linux build box. Clone/use `https://github.com/AutomationsGuru/guru-dev`. **Never** use `AutomationsGuru/GuruHarness`. Read `planning/HANDOFF-CODEX-LINUX-SOL.md`. Bootstrap with `npm ci && npm run typecheck && npm run build && npm test`. **CodeRabbit is gone** — review is peer-agent + CI only. Run the Linux interactive TUI checklist. Fix regressions with CI-green PRs, author `AutomationsGuru <matt@automations.guru>`, no AI co-author trailers. Prefer deep test + debug over drive-by refactors.

---

## 6. Definition of done

- [ ] Clone tracks `guru-dev/main`  
- [ ] Full hermetic suite green  
- [ ] Interactive TUI checklist written (terminal + pass/fail)  
- [ ] PRs merge on CI without any CodeRabbit dependency  
