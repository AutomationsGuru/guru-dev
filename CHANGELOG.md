# Changelog

All notable changes to GuruHarness are documented here.

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
