# Changelog

All notable changes to GuruHarness are documented here.

## [Unreleased]

### Release discipline

- Treat the current harness as pre-GA dogfood. Historical `1.x` labels are not
  daily-driver acceptance evidence.
- Do not bump the package version for a local build, test, install refresh,
  routine PR/push, or ordinary fix. Record work here until a release owner and
  Matthew make an explicit release/migration decision.
- **Stay on `1.5.x` until Matthew is happy with how Guru works.** Patch numbers
  may climb without limit (`1.5.1` … `1.5.n` — even absurdly high is fine). The
  next gated patch target after **1.5.1** is **`1.5.2`**. Do **not** create, tag,
  or publish `1.6.0` or higher until Matthew explicitly accepts Guru as working
  well enough to advance. CI (`scripts/verify-repo.ps1`) and the tag-triggered
  release workflow refuse package versions outside `1.5.x`.

## [1.5.1] - 2026-07-16

Dogfood patch release: fold post-1.5.0 product merges on `main` into an explicit
package version (still **1.5.x** pre-GA). Does not authorize `1.6.0+`.

### Added

- **Home profile, project harness, memory backends, Honcho client** (PR #37).
- **ACDE stack:** MCP meta-dispatch, RPC session graph, G26 schedule wiring,
  G627 operator-question broker, G880 headless API boot (PR #39).
- **G3/G532 sequential:** planner token-budget drawdown + RPC compaction events
  on active graph session (PR #39).
- **G987 sequential:** post-tool shell-hook lifecycle (`tool:result`) (PR #39).
- **RPC `operator.answer` (G708):** `AgentSession` answer-handler + pending-question
  map; RPC method + ready-list advertisement; shutdown `closeQuestions` (PR #42).
- **ask_question session context:** runtime threads allocated `sessionId` into
  interactive callbacks (PR #42).
- **Tool parity `service_health` YELLOW** (G636) mapping to `service_readiness_report`
  (PR #42).

### Changed

- **Doc-control post-#37 hygiene** (PR #38): indexes, headers, example
  `approvalPolicy.autoCommitPushPr: false`.
- **Pipeline-gate mandate** (AGENTS): scheduled review/sync/merge lanes may approve
  and merge when CI green and content is ready (PR #42 docs).
- **Workspace docs / gap / harness-matrix** index refresh (ongoing schedulers).

### Fixed

- Residual shared-worktree product delta rebased onto post-#39 main without
  regressing ACDE/G3/G987 (PR #42).
- Linux npm launcher POSIX symlink / Windows shim entrypoints (prior Unreleased).

## [1.5.0] - 2026-07-12

Lane reconciliation release: merges the 2026-07-10/11 Windows daily-driver wave and the
Codex Linux reliability wave onto the v1.4.2-v1.4.8 line (PR #28), with one
implementation per capability (todo board, web_fetch, web_search, ask_question kept
from the released line; schedule, manage_task, read_diagnostics, shell hooks,
grapheme-aware TUI, and the YOLO hard-edge fixes kept from the wave).

### Integration & delivery

- **License: MIT** (was UNLICENSED on a public npm package) — LICENSE file added.
- **Tag-triggered release workflow** (`release.yml`): verify gates then `npm publish --provenance` on `v*` tags (requires the `NPM_TOKEN` secret).
- **Removed `dependabot-auto-merge.yml`** — it unconditionally approved and auto-merged every Dependabot PR (majors and production deps included), bypassing the guarded `dependabot-automation.yml` next to it.
- **Windows + Node 22 CI job** — the engines floor and the primary dev platform now have CI coverage alongside the ubuntu/node-24 required check.
- **CodeQL clean**: fixed the three alerts the wave introduced (polynomial ReDoS in the composer @-reference parser; shell-string hook execution -> execFile argv arrays, `.bat` hooks dropped in favor of `.ps1`; tainted cmd.exe token in gate spawn -> allowlist-constant shim names).

### Added

- **`manage_task` backend:** in-memory background task registry (list/status/kill/send_input); resets on `/new`.
- **`read_diagnostics` tool:** path-filtered TypeScript diagnostics from repo typecheck (Cursor ReadLints parity).
- **`ask_question` TTY multi-choice prompt:** number keys / arrows / Enter; Space toggles multi-select. Shared interaction gate so mid-turn keys don't become steer drafts. (The wave's duplicate `session_todos` / `read_url_content` / `search_web` tools were superseded during lane reconciliation by the v1.4.2–v1.4.5 `todo_write`/`todo_list`, `web_fetch`, and `web_search` tools; `/new` resets the shared todo board.)
- **`/export [path]`:** write the conversation transcript to markdown (default `.guru/exports/…`).
- **`/copy [n]`:** copy the latest (or Nth-latest) assistant reply to the clipboard (clip / pbcopy / xclip), with print fallback.
- **`/context`:** context-window footprint (tokens, ctx%, turns, route).

### Fixed

- **Linux terminal text correctness:** cursor movement, deletion, wrapping, clipping, and width calculation operate on grapheme clusters, keeping emoji modifiers, ZWJ families, flags, combining marks, and CJK text intact.
- **Reference punctuation capture:** `@file` references no longer absorb trailing comma, period, colon, or closing parenthesis.
- **Idle Ctrl+C draft loss:** quitting now requires two consecutive presses inside the 1.5-second window; ordinary input disarms the pending exit.
- **Narrow-terminal overflow:** status bars and rounded boxes now honor the available width, while `/model` shows a bounded ready-first list and leaves the exhaustive catalog to `/models`.
- **Streaming transport stalls and resets:** SSE accepts CRLF boundaries split across chunks, retries retryable open failures, times out inactive response bodies, and preserves partial text when a stream fails after output begins.
- **Canceled or malformed streamed actions:** Ctrl+C, clean early EOF, truncation/content filtering, and invalid JSON arguments can preserve visible partial text but never authorize or execute an uncommitted tool call.
- **MCP session lifecycle:** configured MCP tools attach to new and resumed runtime sessions, report per-server readiness under `/tools`, and close retained clients across Guru, RPC, API, CLI, capability-smoke, and self-build owners/retries.
- **Command execution ambiguity:** the argv command runner rejects unsupported shell operators and unterminated quotes with a recovery hint instead of silently executing a different command.
- **Bounded UTF-8 reads:** the read tool no longer loads the whole file and never returns a replacement character when byte limits split a multibyte character; `nextOffset` identifies the safe continuation point.
- **Hint line width on resize:** `chromeRows` passes the composer's paint width into `composerHintLine` (was `undefined` → `stdout.columns` drift vs status bar).
- **`abortPrompt` cursor bookkeeping:** resets `lastFrameRowWidths` + `lastCursorCol` like `clear()`/`beginPrompt`, so Ctrl+C idle path can't leave a one-frame stale physical-row map.
- **Alt+Enter follow-up dead on Windows Terminal / xterm:** modifyOtherKeys / CSI-u modifier masks now set `meta` (and `ctrl`) — previously only Shift was decoded, so Alt+Enter never queued a follow-up on WT.
- **Mid-turn steer ignored on no-tool chat turns:** after a plain streamed answer (zero tool rounds), pending steers now continue the agent loop so `↳ steered` reaches the model instead of waiting for the next user line.
- **C1 short-token assignment leak:** unquoted secret assignments like `API_KEY=x supersecret` now redact through the spaced remainder (stop at `;|&` / EOL), not only the first token.
- **Composer `clear()` orphaned header chrome:** clear now moves to the managed block top before erase (same as abortPrompt), so a mid-block clear-below cannot leave the top rule in scrollback.
- **beginPrompt / renderFinal cursor bookkeeping:** reset `lastFrameRowWidths` + `lastCursorCol` so the next relative move cannot use a stale physical-row map.
- **Extension host tests vs CommandHandler contract:** duplicate/isolation tests now call `(args) => void` handlers (typecheck-clean).
- **Spinner ghost text after mid-turn steer:** spinner frames now clear-to-EOL (`\\r\\x1b[K`) so a shorter `working…`/`thinking…` line cannot leave the tail of `steering… <draft>` stuck on screen.
- **Long mid-turn steer draft soft-wrap:** busy draft paint **and** the chatTurn spinner re-paint share `formatBusyStatusLine` (`columns-1` + ellipsis) so the spinner cannot undo the clamp every 80ms.
- **Mid-turn follow-up queue depth:** Alt+Enter busy event line can carry `q:N` (busy `forceRefresh` no longer paints the idle status chrome into the stream).
- **Mid-turn steer draft stacks a line per keystroke:** busy-path draft paint used a trailing newline, so typing while a turn streamed left dead `steering…` lines in scrollback (busy twin of the 1.4.1 xenl fix). Drafts now paint in-place; the spinner yields to the draft instead of overwriting it every 80ms.
- **Steer/follow-up forceRefresh painted the idle composer into the live stream:** `forceRefresh()` no longer repaints the empty prompt + status chrome while `busy` — it only drops the stale cursor anchor so the next idle frame starts clean.
- **Boot memory blanked on one bad learning:** a single malformed learning/date no longer wipes the whole session memory block; bad items are skipped and the last good injection is kept.
- **`/model` override accepted garbage ids:** empty or whitespace-containing model overrides are rejected before connect (instead of failing one turn later with a provider 400/404).
- **No-model chat hint used a wrong catalog index:** “try `/model N`” no longer points at a raw sorted-catalog index (which drifts from the connectable-first drill); it suggests a real `routeId` matching auto-connect.
- **Destructive hard-edge misses under YOLO:** `rm -r -f` / `rm --recursive --force` and `git push -f` now escalate like `rm -rf` / `git push --force` (split and long flags were previously silent-allow under YOLO).
- **Windows recursive delete silent under YOLO:** `del /s /q`, `rmdir /s /q`, and `Remove-Item -Recurse -Force` (plus short forms) now escalate as destructive hard edges — they previously only counted as `exec` and YOLO allowed them.
- **SPACE mandate scoped only to cwd:** write/edit targets outside a SPACE grant escalate even when the operator’s cwd sits inside the grant.
- **Pre-turn busy dead zone:** `AgentSession` is created when `busy=true` so steer / Esc / Alt+Enter work during compaction and the working window (no more "(no active agent session to steer)").
- **Late steer after stream end:** `chatTurn` continues `driveTurn` while steer-kind items remain so `↳ steered` reaches the model without waiting for the next user line.
- **Esc during compaction:** `turnAbort` is armed before `maybeAutoCompact`; compaction summarizer receives the abort signal.
- **Aborted steer queue pollution:** `discardPendingSteers()` on abort so cancelled nudges do not attach to the next message.
- **`ask_question` spinner leak:** mid-turn `ask_question` calls the active turn's `stopSpinner` (same as approval).
- **Follow-up auto-chain idle gap:** `busy` stays true through `drainFollowUpQueue`; nested `chatTurn` sets busy at entry.
- **Empty/aborted assistant turn count:** `onAssistant` no longer logs or increments turns for empty content; late-steer continuations count once per user message.
- **Busy resize mid-steer:** `forceRefresh` reclamps the in-place steer draft at the new width.
- **Steered continuation stream glue:** newline separator before no-tool steer continuations in `agentTurn`.
- **`memory.forget` non-atomic trash write:** trash is written via the same atomic tmp+rename path as other memory mutations; a failed live-file delete no longer loses the only copy.

## [1.4.8] - 2026-07-10

### Added
- **Desktop / PyAutoGUI-class tools** (`pyautogui_status`, `pyautogui_screen`, `pyautogui_mouse`, `pyautogui_keyboard`): dry-run-first computer-use surface with failsafe corners, bounds clamp, risky-hotkey denylist, secret-typing block, sidecar screenshots, and live gate (`GURU_DESKTOP_LIVE` + injected backend + `userApproved`).

### Changed
- Tool parity: **22 GREEN / 2 YELLOW / 0 RED** (only perplexity + repo routing remain YELLOW).

## [1.4.7] - 2026-07-10

### Added
- **`mcp_bridge_status`** — first-class tool over last MCP attach board (ready/missing-env/error + tool counts).

### Changed
- **`web_fetch`** converts HTML → readable text (scripts/styles stripped, links as markdown); parity GREEN.
- Tool parity: **18 GREEN / 2 YELLOW / 4 RED** (desktop still RED; perplexity + repo YELLOW).

## [1.4.6] - 2026-07-10

### Added
- **`ask_question`** — operator multi-choice Q&A (TTY readline; inject `onAsk` for rich TUI). Headless returns `interactive:false` instead of hanging.

## [1.4.5] - 2026-07-10

### Added
- **`web_search`** — DuckDuckGo HTML search (no API key): title/url/snippet hits with size/timeout caps; net mandate. Pairs with `web_fetch` for open-page research.

### Changed
- Tool parity: `web_search` GREEN; Perplexity row notes discovery pair (`web_search` + `web_fetch`).

## [1.4.4] - 2026-07-10

### Fixed
- **Windows gate spawn (Node 20+/24):** stop rewriting bare commands to `.cmd` (triggered `spawn EINVAL` for `node` and broke hang/cancel tests). Prefer `.exe` from `where`, rewrite `npm`/`npx` to `node <cli.js>`, never spawn batch shims with `shell:false`.

## [1.4.3] - 2026-07-10

### Added
- **`provider_cli_status` / `provider_cli_run`** agent tools — matrix probe + dry-run-first delegated run (`userApproved` + policy gates; output redaction).
- Shared TUI **`width` module** with East-Asian-Width Wide BMP symbols (⚡ YOLO chip, ✅❌⭐ …) so status-bar math matches real terminals.

### Fixed
- Provider CLI default status executor no longer pretends bare commands always exist — uses `which`/`where` PATH probe.
- Composer hint line drops whole hints on narrow terminals (no mid-word chop).
- Rounded boxes clamp to terminal width so deep cwd lines no longer shatter boot panels.
- Editor: paste tabs → spaces; ↑/↓ snap off surrogate mid-points; Alt+Enter / Ctrl+Enter modifyOtherKeys decode correctly.

### Changed
- Tool parity: provider CLI family RED → GREEN (desktop PyAutoGUI remains RED).

## [1.4.2] - 2026-07-10

### Added
- **Session task board** (`todo_write` / `todo_list`) + operator `/todo` — multi-step agent work tracking (harness baseline parity).
- **Bounded `web_fetch`** — http(s) GET with size/timeout/redirect caps; net mandate verb.

### Changed
- Tool parity map updated for live MCP attach/bridge and the new research/todo surfaces.

## [1.4.1] - 2026-07-09

### Fixed

- **Composer keystroke leak (Windows Terminal / xterm xenl):** full-width status/chrome rows soft-wrapped and undercounted relative cursor-up, so every keystroke stacked a dead `▸ …` line. Paint now reserves one trailing cell; status bar gap math matches.

## [1.4.0] - 2026-07-09

YOLO-by-default agency + preserve-don't-replace — guru acts like a model harness, not a passive Q&A bot — plus the working-stack daily-driver UX/MCP/self-build hardening from the multi-agent integration.

### Added

- **YOLO-by-default identity**: boot default is YOLO (ordinary permission gates lifted); `/yolo off` engages safe mode. Hard edges (spend / destructive / secrets / ecosystem-auth) still escalate in every mode. Banner + status line announce it.
- **Operating identity rewrite** in the system prompt: WHO YOU ARE, ORIENT YOURSELF, ACT WITHIN THE GUARDRAILS, PRESERVE DON'T REPLACE, BE HONEST.
- **PRESERVE, DON'T REPLACE** mechanical backstop (`src/mandates/preservation.ts`): a write/edit/`fs.edit.apply` that guts existing content escalates as destructive-class even under YOLO; shared guard on main-turn and swarm worker approval paths.
- **Working-stack interactive UX**: provider timeouts, mid-turn Esc/steer/follow-up, approval banner (y/a/n/enter/esc), spinner lifecycle, menu + status polish; `/model` keeps history; model drill connectable-first.
- **MCP attach/client/bridge** and secret-scrubbed stdio JSON-RPC transport (stdin EPIPE-safe; client closed if discovery fails after connect).
- **Self-build hardening**: REVIEW/TEST timeouts, gated SHIP git delivery with bounded `git` timeout, SMOKE session self-call with abort signal.

### Changed

- Auth header construction honors `bearer` / `api-key` / `x-api-key` consistently in streaming and non-stream paths.
- Timeout failures are explicit non-retry (`AttemptFailure` / retry policy); shell tools forward `AbortSignal`.
- Vitest dist build lock no longer swallows real `tsc` errors as lock contention.

### Validation

typecheck / build / **1187 tests** / CI (repo-hygiene + CodeQL + review) green on main.

## [1.3.0] - 2026-07-07

Native plan/OAuth provider auth — every model runs through guru's own engine, with exactly two auth mechanisms (API key, or a guru-native OAuth login) and **no CLI delegation**.

### Added

- **Native ChatGPT/Codex plan auth** (`openai-codex`): `/login` runs guru's OWN browser loopback PKCE sign-in against auth.openai.com and vaults the token; the ChatGPT-plan Responses lane runs natively (`chatgpt.com/backend-api/codex`).
- **Native SuperGrok plan auth** (`grok`): `src/model/oauth/xaiGrokLogin.ts` — the **RFC 8628 device-code flow** (what the real Grok CLI uses): no loopback port (immune to Windows reserved-port ranges), works headless. Correct scopes (`grok-cli:access api:access`); refresh-token rotation.
- **Opportunistic CLI-cache shortcuts** (never a dependency): if a provider CLI already signed in, guru reuses `~/.codex/auth.json` / `~/.grok/auth.json` instead of re-prompting — honoring the standalone rule (guru needs only itself).
- Readiness/`/accounts` now report guru-OAuth lanes as connected when a vaulted or cached token is present.

### Changed

- **Removed the CLI-delegate lane entirely** — deleted `src/model/cliDelegateTurn.ts` and the `openai-codex` delegate route; no turn is ever delegated to a provider CLI. The auto-connect picker is direct-first and never selects a delegate.
- **Provider lanes corrected to authoritative endpoints**: `minimax` → `api.minimax.io/anthropic` (anthropic-messages, the full coding setup, one key); Z.ai split into `zai-coding` (plan, `api.z.ai/api/anthropic`) and `zai-api` (platform, `api.z.ai/api/paas/v4`), disentangled from the separate `bigmodel` (Zhipu mainland) lane; `grok` retargeted to the SuperGrok proxy with the device-code flow.
- 101 routes across 20 providers (was 103/21 with the delegate lane).

## [0.1.0] - 2026-06-17

Release-prep status: artifacts prepared only; no tag or release has been cut.

### Added

- Repo-aware TypeScript harness foundation with normalized result contracts and done packets.
- Bounded self-build loop with HERE/THERE direction checks and task dependency ordering.
- Schema-first configuration loading, typed tool registry, and runtime skill loading.
- Repo context and AGENTS.md chain discovery for target repositories.
- Validation, review, git/PR automation, and repository hygiene gates.
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
