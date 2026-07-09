# Handoff — Codex on Linux (Sol) · GuruHarness daily-driver + build lane

**Date:** 2026-07-09  
**Audience:** Codex (or any agent) on the **Sol / Linux build box**  
**Windows counterpart:** Matthew daily-drives `guru` on Windows; Linux is the **big build + test + deep debug** machine.  
**Goal:** Get Codex current, green, and useful for **test everything**, **debug**, and **ultracode-style multi-file work** on GuruHarness.

Read this first, then `README.md`, then the code map below. Do **not** invent a second remote history.

---

## 0. One-screen status (verified 2026-07-09)

| Item | Value |
|------|--------|
| **Product** | GuruHarness — interactive agent harness CLI `guru` + SDK |
| **Version** | **1.4.1** (`package.json`, npm, GitHub release) |
| **Canonical git remote** | `https://github.com/AutomationsGuru/guru-dev.git` — track as **`guru-dev`**, branch **`main`** |
| **npm** | `npm install -g guruharness@1.4.1` · package name **`guruharness`** · maintainer `mchappy` |
| **Open PRs** | **none** (clean main) |
| **Tests (Windows, post-1.4.1)** | typecheck clean · full vitest green (≈1187+; re-count after pull) |
| **Superseded remote** | `AutomationsGuru/GuruHarness` (`origin` on some Windows trees) — **unrelated history. Never merge/reconcile.** |

### What just shipped (context for testing)

- **v1.3.0** — native plan/OAuth (ChatGPT + Grok), CLI delegate removed  
- **v1.4.0** — YOLO-by-default agency + PRESERVE/DON'T REPLACE mechanical guard + working-stack UX/MCP/self-build  
- **v1.4.1** — **composer keystroke line-stack fix** (Windows Terminal xenl / full-width status bar). **Linux must confirm typing stays on one line** (primary cross-platform gate).

---

## 1. Clone and bootstrap (Linux / Sol)

```bash
# Node ≥ 22 required (engines)
node -v   # expect v22+

# Prefer a clean tree on the big box — do NOT clone GuruHarness (old lineage)
git clone https://github.com/AutomationsGuru/guru-dev.git guruharness
cd guruharness
git remote rename origin guru-dev   # optional clarity; or leave as origin if only one remote
git fetch --tags
git checkout main
git pull guru-dev main   # or: git pull origin main

npm ci                   # preferred over npm install
npm run typecheck
npm run build
npm test                 # full suite — this machine should own long runs

# Optional: global CLI from npm (parity with Windows daily driver)
npm install -g guruharness@1.4.1
guru --version           # expect 1.4.1
```

**Dev CLI without global install:**

```bash
npm run build
node dist/guru.js --version
# or
npx tsx src/guru.ts
```

**Auth for real model turns (optional for unit tests; required for live dogfood):**

- API keys via env (names only in docs — never commit values)  
- Plan lanes: `guru` then `/login` for ChatGPT (`openai-codex`) or Grok device-code (`grok`)  
- Auto-connect is **direct-first** (vaulted OAuth or API key with baseUrl)

---

## 2. Git / PR contract (same as Windows agents)

- **Remote of record:** `guru-dev` → `AutomationsGuru/guru-dev`  
- **Author:** `AutomationsGuru <matt@automations.guru>` only — **no** `Co-Authored-By: Claude` / Codex trailers on commits or PR bodies  
- **Flow:** branch → PR → CI (`repo-hygiene`, CodeQL) + **CodeRabbit** → fix majors → **merge yourself** (Matthew does not hand-review)  
- **Required checks:** `repo-hygiene`, `CodeRabbit` status; linear history; 1 approving review (CodeRabbit approve when clean)  
- **Release:** bump `package.json` + `package-lock.json` → README badge/install → PR → tag `vX.Y.Z` → GitHub release + `npm pack` tarball → **`npm publish`** (token in 1Password `npm_access_token` / env `NPM_TOKEN`)  
- **Secrets:** presence-over-value; never print keys; no real-looking fixtures in source (GitHub push protection)

Direct Codex model routing preference (Agent OS): **`codex --profile fugu` / `codex --profile fugu-ultra`** when available — not LiteLLM first.

---

## 3. What to read (in order)

1. **This handoff**  
2. `README.md` — public contract, install, pillars  
3. `CHANGELOG.md` — 1.3 / 1.4 / 1.4.1  
4. `planning/SELF-BUILD-LOOP-HARDENING.md` — remaining self-build hardening (if touching self-build)  
5. Constitution / THERE if present outside clone (Windows path `P:\guruharness\planning\THERE.md`) — optional for deep product work  

Code roots (all under clone root = former `main/`):

| Area | Path | Why |
|------|------|-----|
| Interactive TUI / REPL | `src/guru.ts` | Composer, boot ritual, YOLO, approvals, auto-connect |
| Composer paint / keys | `src/tui/editor.ts`, `keys.ts`, `composer.ts` | **1.4.1 xenl fix lives in `guru.ts` paintFrame** |
| Agent turn / SSE / retry | `src/model/agentTurn.ts`, `retryPolicy.ts` | Timeouts, abort, header styles |
| OAuth | `src/model/oauth/*` | ChatGPT PKCE, Grok device-code |
| Mandates / preservation | `src/mandates/*` | YOLO gates, **preservation.ts** gutting guard |
| Self-build loop | `src/selfbuild/*`, `src/cli.ts` | `self-build-run` |
| MCP | `src/mcp/*` | attach, stdio JSON-RPC |
| Tests | `tests/**` | Mirror of src; start here for regressions |

---

## 4. Mission on Sol — test matrix (do this first)

### 4.1 Hermetic (no keys) — always green before any PR

```bash
npm run typecheck
npm run build
npm test
# Focused when touching surfaces:
npx vitest run tests/guru tests/tui tests/model tests/mandates tests/selfbuild tests/mcp
```

**Pass criteria:** exit 0; no flaky retries as “green.”

### 4.2 Linux interactive TUI (highest priority vs Windows)

Windows just fixed **every-keystroke-new-line** composer bug (v1.4.1). On Linux:

```bash
guru
# or: node dist/guru.js
```

Manual script:

1. Splash shows **v1.4.1**  
2. Boot ritual completes; YOLO banner present  
3. **Type a long sentence** — prompt must stay **one line** (or wrap as a single editor frame), **not** one scrollback line per character  
4. Backspace, arrows, Ctrl+J newline, Enter submit  
5. `/help`, `/model`, `/yolo off`, `/yolo on`  
6. Esc / Ctrl+C interrupt behavior when idle (double Ctrl+C exits)  
7. Resize terminal mid-prompt — chrome reflows without stacking garbage  

**File a bug + fix PR** if Linux still stacks lines or cursor drifts (different terminals: gnome-terminal, kitty, tmux, ssh).

### 4.3 Platform / path edges (Linux-owned)

- Repo discovery under real git worktrees and non-Windows paths  
- `bash` tool / shell allowlist vs PowerShell-oriented tests  
- UNC/P: drive logic should no-op or degrade cleanly on Linux  
- File watcher / git status timeouts under heavy FS  

### 4.4 Live model dogfood (when credentials available)

```bash
guru
# /login openai-codex   or   /login grok   or API key vault
# send: "list files in this repo and summarize package.json version"
```

Confirm: tool loop, streaming, abort mid-turn, steer (type + Enter while busy).

### 4.5 Self-build smoke (optional, spend-gated)

```bash
node dist/cli.js self-build-run --dry-run
# --run only with explicit mandate + keys + spend awareness
```

---

## 5. Known hotspots / recent bugs (debug starting points)

| Symptom | Likely area | Notes |
|---------|-------------|--------|
| One line of scrollback per key | `src/guru.ts` `paintFrame` / `buildStatusBar` | Fixed 1.4.1 via **columns−1** paint + status gap; re-verify on Linux TTYs + **tmux** |
| Mid-turn keys feel dead | busy steer path in `attachComposer` | Esc/Ctrl+C abort; Enter steers |
| Approval Esc aborts whole turn | approval vs busy-key gate | Fixed on working-stack; keep regression |
| Streaming hang | `agentTurn` + `retryPolicy` | timeout = non-retry; abortableSleep |
| MCP orphan processes | `src/mcp/attach.ts`, `jsonRpcStdio.ts` | close on discover fail; stdin error handler |
| Gutting overwrite under YOLO | `src/mandates/preservation.ts` | write/edit/`fs.edit.apply` escalate destructive |
| Wrong auth header | `openSseResponse` / `postJson` headerStyle | bearer / api-key / x-api-key |

**Composer regression tests:** `tests/guru/composer.test.ts` (xenl + in-place clear), `tests/guru/statusBar.test.ts` (width = columns−1).

---

## 6. How Codex should work here (ultracode / Sol)

Sol is the **build farm**. Prefer:

1. **Full suite + typecheck** after every meaningful change (this box can afford it).  
2. **Parallel exploration** (read-only): map tests vs src before editing.  
3. **Worktree isolation** for multi-writer parallel fixes; always branch from **fresh `guru-dev/main`**.  
4. **Small PR slices** when possible; one concern per PR; keep main releasable.  
5. **Report format** at goal end: Status · Complete · Commands run · Failures · Follow-ups · Version impact.

### Suggested first Codex session goals (ordered)

1. Bootstrap clone + `npm ci` + full `npm test` — baseline green log.  
2. Interactive Linux TUI checklist (§4.2) — **pass/fail report** with terminal emulator named.  
3. If TUI fail → minimal fix PR → 1.4.2.  
4. If TUI pass → pick next value: self-build HIGH leftovers in `planning/SELF-BUILD-LOOP-HARDENING.md`, or Linux path/shell dogfood gaps.  
5. Keep Windows ↔ Linux parity notes in PR bodies (what Windows already verified).

### Paste-ready Codex kickoff

> You are on the Sol Linux build box. Clone/use `https://github.com/AutomationsGuru/guru-dev` (remote name `guru-dev` if multi-remote). **Never** use `AutomationsGuru/GuruHarness`. Read `planning/HANDOFF-CODEX-LINUX-SOL.md` first. Current ship is **guruharness@1.4.1**. Bootstrap with `npm ci && npm run typecheck && npm run build && npm test`. Then run the Linux interactive TUI checklist in that handoff (composer must not stack a line per keystroke). Fix any Linux regressions with CI-green PRs, author `AutomationsGuru <matt@automations.guru>`, no AI co-author trailers, merge when CodeRabbit + CI pass. Prefer deep test + debug over drive-by refactors. Report results with commands and pass/fail.

---

## 7. Windows machine notes (do not assume on Sol)

| Windows path | Meaning |
|--------------|---------|
| `P:\guruharness\main` | Working clone (often network share) |
| `P:\guruharness\handoffs\` | Local/orchestrator handoffs (may **not** be in git) |
| `R:\` | Research/handoff storage root (Agent OS) |
| Global `guru` | From `npm i -g guruharness` |

On Sol, **only trust the git clone + npm**. Copy this file from the repo after pull.

---

## 8. Definition of done for “Codex is up to speed”

- [ ] Clone on Sol tracks `guru-dev/main` @ **≥ v1.4.1**  
- [ ] `npm ci && npm run typecheck && npm run build && npm test` green  
- [ ] `guru --version` → 1.4.1 (global or dist)  
- [ ] Interactive TUI checklist written up (terminal + pass/fail)  
- [ ] Codex can open PRs that pass CI + CodeRabbit without Matthew babysitting  
- [ ] Optional: one live model turn dogfood noted  

---

## 9. Contacts / ownership

- **Owner:** Matthew  
- **Windows daily driver + release:** recent sessions on Windows (1.4.0 npm publish, 1.4.1 composer fix)  
- **Linux Sol:** Codex owns build farm validation and Linux-specific fixes  

When this handoff goes stale, update version table + open PR list + “what just shipped” only — keep the bootstrap and test matrix stable.
