# Guru Harness

[![CI](https://github.com/AutomationsGuru/guru-dev/actions/workflows/ci.yml/badge.svg)](https://github.com/AutomationsGuru/guru-dev/actions/workflows/ci.yml)
![guru harness](https://img.shields.io/badge/guru%20harness-AI%20agent%20harness-8C11E1?labelColor=1A1130&style=flat-square)
![node](https://img.shields.io/badge/node-%E2%89%A522-B56EF1?labelColor=1A1130&style=flat-square)
![tests](https://img.shields.io/badge/tests-1480%20passing-31C48D?labelColor=1A1130&style=flat-square)
![package](https://img.shields.io/badge/package-v1.5.1-E958BE?labelColor=1A1130&style=flat-square)
![maturity](https://img.shields.io/badge/maturity-dogfood-F59E0B?labelColor=1A1130&style=flat-square)
![license](https://img.shields.io/badge/license-MIT-31C48D?labelColor=1A1130&style=flat-square)

**`guru` is a repo-aware terminal agent harness.** `cd` into any project, launch it, connect the model you want — your own provider API keys or a provider subscription/plan — and it does real coding work: reads your code, edits files, runs your tests, and iterates to green, with every action shown and every mutation behind an approval gate.

![the guru boot splash — rendered by the shipped TUI renderer](assets/readme/splash.svg)

## The idea

Guru does not sit on top of an agent framework. No orchestration SDK, no framework-of-the-week underneath — the runtime is **independent TypeScript**, hand-rolled down to the ANSI escape codes. `zod` is its core runtime dependency; PostgreSQL and Honcho adapters are optional, explicit memory integrations. That isn't minimalism for its own sake; it's the thesis:

> **A harness that depends on someone else's framework inherits someone else's ceiling.**
> Guru builds its own — and then keeps building.

The name means both things at once, on purpose. A harness **captures the value** of every model and tool it touches, and **directs that power** where the operator points it. And *Guru* because it **knows from experience** — every day it works, it saves what it learned, and tomorrow it's sharper.

The finished-product definition is present-tense and testable, and a line-by-line, adversarially-verified capability audit drives the build order.

## Release maturity

Guru is currently in dogfood development. It is **not** yet the fully working
daily-driver harness represented by a product-quality `v1.0`. Existing `1.x`
package identifiers are historical distribution labels, not proof that the
acceptance bar has been met.

Local fixes, builds, test runs, and routine merges do not change the package
version. They belong in the `Unreleased` changelog while real target-project
dogfooding establishes reliability. A public version correction or migration is
a separate release-owner decision because `1.x` has already been published.

## How it works

Every capability gap has a named move — **build, attach, or learn-and-replicate** — so "stuck" stops being a state Guru accepts. The never-stuck resolver states which move it chose and why:

- **Build** — write the capability (an extension/tool), test it, and register it through the one frozen extension seam. New capability never edits core.
- **Attach** — wrap a capable thing that already lives on the machine (a CLI, an SDK) as an owned, approval-gated adapter, tracked as a parity gap until a native version replaces it — never a silent dependency.
- **Learn** — replicate a capability from evidence, gated the same way.

**Roles emerge from work.** There are no shipped roles. The first day on a domain builds that role's loadout; the tenth loads it in seconds. At end of day the role is saved richer than it started — new verified capability, new learned paths, the *why* attached. **Experience compounds, per role, forever.**

**Self-building is the survival condition.** A compiled snapshot drifts into obsolescence; Guru re-forms against the world every time it wakes — proposing improvements from real evidence (the capability manifest, the probe matrix, per-role path-outcomes) and shipping them through the full gate stack. The one absolute guardrail: **there is no unattended self-improvement loop.** Validation + review + approval + done packet bind every self-mutation, in every mode. The gates are not a phase — they are the constitution.

## A day with guru

**Install is the whole setup.** Fresh machine: install Guru, run `guru`. It boots bare — no connected model, no roles — and it *knows* it: the briefing shows exactly what's missing. Providers whose keys already exist in your environment (or in the encrypted guru vault) simply light up; for plan providers, `/login <provider>` runs **guru's own** sign-in (a native browser/device-code OAuth flow) and vaults the token — no other CLI required. Minutes after install, Guru is talking to the models your keys unlock.

**The work** is long stretches of real autonomy. Guru holds the task, makes the hundred small calls that are its to make, and doesn't tug your sleeve to ask how to tie its shoe. Needs to explore six places? Six read-only workers go out (`spawn_agent`), and Guru knows. And when you enable the look-ahead engine (`/lookahead`, off by default), read-only scouts pre-explore the likely forks in dead time — so when reality forks, the path past it is often already reasoned through. It stops you only at real edges: spend, destruction, secrets, out-of-scope.

**The feel:** confident, not cocky. Obedient when you've made the call, autonomous when you haven't. It never plans forever instead of acting, never argues you out of your own decision, and asks a question only when the answer changes what it does next. Given task, goal, resources, and tools — it uses its brain and gets it done.

![a session frame composed with the shipped renderer — tool trace, retry + compaction indicators, the / menu, the pinned status bar](assets/readme/session.svg)

And it survives its own turns: near the context window, older history folds into an iterative summary instead of dying (`⛁ compacting`); transient provider errors back off with a visible `↻ retrying`; runaway commands are actually killed, with the partial output kept as evidence.

## Install

Published on npm as [`guruharness`](https://www.npmjs.com/package/guruharness) (v1.4.1+).

```bash
# Global CLI (recommended)
npm install -g guruharness
guru --version

# As a project dependency
npm install guruharness

# Development (from source)
git clone https://github.com/AutomationsGuru/guru-dev.git && cd guru-dev
npm install && npm run dev:install
```

`npm run dev:install` builds the checkout, globally links it, and verifies that
the `guru` command resolves to that checkout. After every runnable source-code
change, run `npm run dev:sync` before testing: it rebuilds and refreshes the
global link without publishing or changing the package version. Restart a
running Guru process after syncing; a newly launched `guru` then uses the
latest local build.

On Linux, run this from a user-owned clone on a native Linux filesystem with
Node 22+ and a writable `npm root -g`. Do not use `sudo npm link`; if the global
npm directory is root-owned, use the builder's user-owned Node installation
instead. Shared CIFS/no-exec mounts are unsuitable for npm's native binaries.

> Prefer the npm package. A GitHub release tarball (`gh release download v1.4.1 …`)
> still works as a fallback if you need an offline/air-gapped install.

Installing it exposes the `guru` CLI/RPC bin **and** the in-process SDK:

```ts
import { AgentSession } from "guruharness/session"; // or from "guruharness"
const session = new AgentSession({ runtime, route, session, sessionTools, mandate });
session.subscribe("token", ({ chunk }) => process.stdout.write(chunk));
await session.prompt("explain the auth flow");
```

```bash
guru --mode rpc        # headless: LF-delimited JSONL over stdio, same engine
guru keys set <NAME>   # save an API key to the encrypted vault (hidden prompt)
```

Actual registry publishing is a gated operator action (name/scope, license, and a
`publish-on-tag` CI workflow are decided then — see the ADR).

## Quick start

```bash
cd your-project
guru
```

You get the full-width splash, then a **briefing**: connected model + context window, registered tools with their live access/availability, skills, memory status, saved conversations, route readiness, theme. The composer pins a live status bar under the input — cwd · role · YOLO/scout/mandate chips · tokens · ctx% · model — and reflows on resize.

### Home profile and project harness

Guru keeps its reusable installed profile at `~/.guruharness` (for example, `C:\Users\agentos\.guruharness` on Windows). On its first normal launch in a target folder, it creates a project-specific `<project>/.guru` harness:

- `harness.json` records the generated harness, its linked assets, and the current native tool/skill catalog.
- `skills/local/`, `memory/`, `hooks/`, `agent/prompts/`, `state/`, and `change-records/` belong to the project.
- `skills/global`, `garage`, and `tools` are live directory links to the reusable home profile—never copied snapshots—so home-side updates are immediately available to every project.
- `.guru/guruharness.config.json` is seeded once from the home default, then belongs to that project. Edit it freely without changing other projects or the home profile.

Configuration resolves in this order: an explicit config path, a root `guruharness.config.json` owned by the project, the generated `.guru/guruharness.config.json`, then the reusable home default. This keeps the Guru source repo's own config authoritative during development while ordinary projects receive a tailor-made writable default.

- **The composer is a real editor**: **Ctrl+J** newline (multi-line prompts in place; Shift+Enter where the terminal reports it), **@path** opens a fuzzy picker AND **expands the file contents into the prompt** (50KB + context-window guards, secret-scrubbed), **Tab** completes paths — history and the menu intact
- **Prompt templates** — drop `.guru/agent/prompts/*.md` (frontmatter arg schema); `/name arg…` expands with `{{arg}}`, surfaced in the / menu
- **`/`** opens the command menu — type to filter, **↑/↓** navigate, **→** drills into live lists (`/model` → routes, `/resume` → saved sessions), **⇥** accepts, **⏎** runs
- **`/model`** — the 101-route catalog across 20 providers (direct API keys, native plan/OAuth auth, local models); credential presence by env NAME only — values are never read or printed
- **`/login` / `/accounts` / `/logout` / `/keys`** — **two auth mechanisms, nothing else**: an **API key** (layered resolution: env NAME → the **encrypted guru vault** → optional `$VAR`/`$(cmd)` template), or a **guru-native OAuth login** for plan/subscription providers. `/login <provider>` runs guru's OWN sign-in — a browser loopback (ChatGPT/Codex plan) or an **RFC 8628 device-code** flow (SuperGrok plan) — and stores the token in the **AES-256-GCM vault** (`~/.guruharness/vault.enc`); if a provider CLI already signed in (`~/.codex`, `~/.grok`), guru reuses that cache as an opportunistic **shortcut, never a dependency**. No CLI delegation, ever. `/keys` (+ `guru keys set <NAME>`) saves an API key to the vault as an env-var alternative
- **YOLO by default, `/mandate`, safe mode** — guru boots in **YOLO** (its baseline: ordinary permission gates lifted from the start). Routine project-contained argv commands are open to ordinary executables; the runner remains argv-only, cwd-contained, and bounded. Engage **safe mode** with `/yolo off` — the opt-IN leash — and a mutating tool call not covered by a standing grant **prompts you per-call** (`y` once · `a` always this session · `enter`/`N` deny); standing mandates grant space/machine scope ("this repo is yours"). In **every** mode, YOLO included, **hard edges prompt every time**
- **`/compact [instructions]`** — manual compaction; it also auto-triggers near the window (tool-pair-safe cut, scrubbed, resumable)
- **`/remember [global|space|role]` / `/memory` / `/recall`** — Markdown fact memory is the zero-setup default: frontmatter + `[[links]]`, an Obsidian-compatible vault, and a derived `MEMORY.md` index. It is scoped as **global** (`~/.guruharness/memory/`), **space** (`<repo>/.guru/memory/`), and **role** (`~/.guruharness/roles/<slug>/memory/`). Set `memory.storage.provider` to `postgres` to use any PostgreSQL database via the configured connection-string environment-variable name; `/memory` reports which backend is really active. `memory.honcho` is an optional, disabled-by-default context layer using the official Honcho SDK; it never pretends to be connected until configured. With **`memory.honcho.syncOnTurn`**, turn summaries are logged in the background via the registered **`honcho_log_turn`** tool (not on the default model chat tool surface — see `../gaps/README.md` **G663**). Boot injection re-ranks facts by BM25 relevance to the current turn, and `/recall <query>` surfaces related memory on demand.
- **`/role`** — dynamic load and save of a role on a **typed capability manifest**: a role is verified layers (tool/skill/extension/provider/command) with per-layer verification hashes; saving is verified-only (a BUILT layer refused without its done packet) via an atomic two-phase commit, and loading **re-verifies stale/changed layers first** (failed layers skipped, a clean role loads on the fast path); **`/lookahead`** — the scout/commit engine (off by default = byte-identical turns)
- **`/sessions` / `/resume`** — conversations persist and resume with route, compaction state, and file tracking intact
- **`/tree` / `/fork` / `/clone`** — the session **tree**: an append-only JSONL DAG (`id`/`parentId`, audit markers, crash-resume by replay); `/tree` navigates fork points and child branches, `/fork <#>` branches from a prior user turn, `/clone` duplicates the active branch for destructive experiments — with **branch summaries** folded on leave and injected on return

### Memory configuration

`/memory` shows the active backend and Honcho state; `/settings` shows the configured names. For a normal project launch, edit `.guru/guruharness.config.json` to change them, then restart Guru; a root `guruharness.config.json` remains the explicit project/development override. After selecting PostgreSQL, `/memory migrate` explicitly copies eligible global Markdown facts without deleting the source. Connection strings and API keys stay in environment variables, never in this file.

```json
{
  "memory": {
    "storage": {
      "provider": "postgres",
      "postgres": {
        "connectionStringEnvVar": "GURU_MEMORY_DATABASE_URL",
        "schema": "guru_memory",
        "table": "facts",
        "ssl": "require"
      }
    },
    "honcho": {
      "enabled": true,
      "apiKeyEnvVar": "HONCHO_API_KEY",
      "workspaceId": "my-workspace",
      "sessionId": "guru-memory"
    }
  }
}
```

PostgreSQL is the canonical fact store for this first database-backed release and uses one configured global namespace. Markdown retains the existing global/space/role vault scopes. Honcho adds derived context and turn sync; it does not replace the deterministic fact store.

## What's inside (all ground-truth verified)

| Capability | Proof |
| --- | --- |
| Agentic tool loop (read/bash/edit/write, approval-gated) | Autonomous multi-file repair + feature creation shakedowns, `npm test` verified after each run |
| Multimodal (read-only) | **`read`** with **`allowImage=true`** consumes images in context — no built-in **`image_gen`** / **`image_edit`** / video tools (harness-matrix **P** vs Grok/Codex **Y**; `../gaps/README.md` **G643**) |
| The composer editor (multi-line, @ files, Tab paths) | Hand-rolled key decoder + pure buffer reducer; every key behavior keystroke-tested with real escape-sequence bytes |
| Render-layer secret sanitizer | EVERY tool result passes the shape+value scrub at the registry choke point — a `cat .env` structurally cannot leak keys |
| Typed grep/glob/ls + bash token optimizer | Structured results (~60% fewer tokens than raw bash); optimizer compresses noisy output under a never-worse guard (off by default) |
| Context compaction (auto + `/compact`) | Cut-point never splits a tool call from its result (unit-proven invariants); split-turn dual summary; failures degrade — never destroy history |
| Turn-loop retry + bash cancellation | 429/5xx/network back off exponentially (Retry-After honored, absurd delays fail fast); killed children report `cancelled` with partial output |
| Three API families + streaming | openai-chat-completions, openai-responses, and anthropic-messages families, with SSE streaming (unit parity across all three) |
| Native plan/subscription auth (no CLI dependency) | Every model runs through guru's OWN engine — **two auth mechanisms only**: an API key, or a **guru-native OAuth login**. On the plan lanes — ChatGPT/Codex (`openai-codex`, browser loopback PKCE) and SuperGrok (`grok`, RFC 8628 device-code) — guru signs in through its own flow, vaults the token, and turns bill to your **subscription** (no provider CLI is spawned, no per-token API charges); the API-key lanes bill per token as usual. An existing CLI cache (`~/.codex`/`~/.grok`) is reused as a shortcut when present, never required. |
| Per-call approval (§12) | A mutating tool call that escalates **prompts the operator per-call** — `y` once / `a` always-this-session / `enter`·`N` deny (fail-safe default). **Hard edges** (destructive / spend / secrets-adjacent / ecosystem-auth) prompt **every time**, never auto-approved by a session grant; swarm workers never prompt (escalate = deny unless already session-approved). Approval is per verb, per call. |
| Layered credential resolver + encrypted vault | env NAME → the **encrypted guru vault** (AES-256-GCM, `~/.guruharness/vault.enc`, an env-var alternative for keys that can't live in the shell) → optional `$VAR`/`$(cmd)` template → provider-ecosystem cache. Vault values resolve by name **without touching `process.env`** (no child-process leak); everything is in-memory, non-enumerable, scrubbed from every surface, names-only listing. |
| Memory organ (Markdown or PostgreSQL) | Markdown vault + derived `MEMORY.md` is the default; a configured PostgreSQL table is a selectable canonical fact store, and `/remember` facts are injected into future boots. Honcho is optional context enrichment, not a fake database client. |
| Mandates + YOLO permission model | Read-only floor → deny-wins → hard-edge escalation → YOLO → covering grant; the constitution survives YOLO (deny + hard edges resolve **before** YOLO, so YOLO can never lift them) |
| Swarm v1 + look-ahead engine | Workers ≤ parent mandate at execution time; scouts read-only + dead-time-only; per-spawn token/iteration budgets + a structured recursion-depth error; the look-ahead governor bounds speculation (idempotency allowlist default-nothing, per-session budget, miss-rate throttle) |
| Dynamic roles + never-stuck resolver | Roles save/resume on the typed manifest; capability gaps resolve build/attach/learn with evidence, gated at risk edges |
| Typed capability manifest (`/role`) | A role is typed layers with per-layer verification hashes + covering-tests refs; atomic two-phase save commit; verified-only (a BUILT layer refuses to save without its done packet); re-verify-before-load skips failed layers, a clean role loads on the fast path; legacy flat-role saves still load |
| Hard edges survive YOLO (Article 3) | Destructive / spend / secrets-adjacent-write / ecosystem-auth-file ops escalate in EVERY mode including YOLO, and YOLO never cascades to swarm workers — constitution-honest under YOLO |
| Knowledge flywheel (roles compound) | EXTRACT→GATE→STORE→INJECT→CITE→DECAY on typed learnings: saving extracts grounded learnings, boot injects them **decay-ranked** (confidence × citations ÷ age, task-boosted) not a flat dump, used learnings are cited and rise, uncited ones decay + prune, and an L3-rule-vs-L2-skill conflict surfaces for review — never silent |
| L0→L3 promotion diagonal (§8) | Knowledge **compresses upward**: a **validated**, cited L1 episodic clusters into an L2 skill (2 cites), a widely-cited L2 skill into an L3 rule (4 cites), and an uncited skill/rule **demotes** — the validation gate keeps unvetted self-generated knowledge out of the skill/rule tiers (self-gen never auto-promotes). Each level change re-ids the fact and prunes the old. |
| Memory scopes (§7) | Memory is **addressable by context**, not one flat pile: **global** (the operator everywhere), **space** (`<repo>/.guru/memory` — travels with the repo), **role** (`~/.guruharness/roles/<slug>/memory`). A scope is a physical store; boot injection unions the active scopes and dedupes **most-specific-wins** (role ▸ space ▸ global). The flywheel-at-save compounds a role's learnings **in its own namespace** (with a self-healing one-time migration of legacy flat learnings); capability manifests + gap records stay global (machine-scoped) by design. `/remember [global\|space\|role] <fact>` targets a scope. |
| Smart Connections (§7) | Injected memory is re-ranked by **relevance to the current turn**, not just recency/decay — a hand-rolled **BM25** index (Okapi, `k1=1.5`/`b=0.75`, positive IDF; **zero new dependency**, no vector DB) over facts + learnings. `chatTurn` rebuilds the injected block with the live user message as the query (no-op when memory is empty — the byte-identical path is untouched); the query's terms also seed the learnings' task boost. `/recall <query>` exposes the same signal as a lookup. |
| Skills: multi-root + **bridge loading** (§14/§16) | Skills load from **project → user → role** roots (path-sandboxed, duplicate-id-guarded), and a skill can declare `type: bridge` — an **ATTACH-class** capability borrowed from an external harness. The constitution forbids a silent DEPEND, so every bridge skill is loaded, flagged `[bridge]`, **and tracked as a parity gap** (`move: attach`, a boot-evaluated trigger) — never an untracked dependency. `/skills promote <id>` graduates a bridge to native (rewrites its frontmatter, closes the gap). |
| Enforced boot ritual (§4) | Five ORDERED, non-skippable phases as deterministic code every wake — kernel assertion → typed capability inspection → decay-ranked memory injection → work-declaration + proactive resolver → baseline health — with a persisted **session counter** (the flywheel's real decay clock) and **gap records** whose presence triggers re-evaluate every boot (a satisfied trigger closes the record — anti-obsolescence) |
| AgentSession engine (§14, in-process SDK) | A first-class importable `AgentSession` runs a full agentic turn on the shared primitives — `prompt`/`subscribe` (typed events)/`steer`/`followUp`/`suitUp`/`park`/`stats` — with an injectable turn-runner (deterministically testable, no network) and a steering queue. **The interactive REPL now drives this same engine** via a turn-execution seam (`driveTurn`), so TUI and SDK share ONE engine (verified byte-identical on a live turn). The substrate the RPC surface + npm SDK package sit on. |
| Headless RPC (`guru --mode rpc`, §14) | LF-delimited JSONL over stdio (StringDecoder framing — never readline; U+2028-safe), driving the SAME engine as the TUI: `prompt`/`steer`/`follow_up`/`abort`/`state`/`suit_up`/`park`/`models`, with streamed typed events. `abort` really interrupts a running turn; `steer` injects mid-run. Emits the **`secret_sanitized`** event (pattern name only, never a value) at the sanitizer choke point — redaction is auditable. |
| Scheduled / recurring in-session tasks | **`schedule`** ships in the tool registry but is **`YELLOW`** in **`toolParity`** — default runtimes omit **`onSchedule`**, so execute throws; not on default model chat surface. Peer harnesses (Grok **`/loop`**, Claude Routines) are out-of-process parity (**G651**/**G802**; harness-matrix **P**). **`manage_task`** lists/kills background registry tasks only. |
| Resumable sessions | Cross-restart resume with context, compaction record, and route intact |
| Cross-harness import (`--continue`, §16) | Pick up a conversation started in **another harness on the machine**: pure mappers translate a foreign JSONL transcript into a fresh durable guru session — most-recent-by-mtime discovery with a scan-all fallback. **Import-only**: tool calls fold into a `[used tools: …]` annotation, tool output is dropped, **nothing is re-executed**. Foreign content is untrusted, so every message is scrubbed for secret-**shapes** (not just registered values) before it persists. `message[0]` keeps guru's system prompt + a provenance banner, then hands off to the same `switchToSession` seam as `/resume`. |
| Session tree (`/tree` `/fork` `/clone`) | Append-only JSONL DAG (`id`/`parentId`, `schemaVersion`, audit markers); lossless stream — a fork/clone keeps every line of both branches alive; crash-resume by deterministic replay; branch summaries via the compaction summarizer; legacy flat-JSON sessions still load |
| Terminal Design System | Operator-owned truecolor theme (`~/.guruharness/theme.json`), 256/16/`NO_COLOR` fallbacks, full-width splash, pinned composer + status bar |
| Direct-first routing | Plan/OAuth routes never touch a router; an external routing sidecar is optional, not embedded |
| Autonomous one-shot run (`guru run`) | CLI **`runSelfBuildExecutor`** for a task directive — **`failClosedMandatePolicy` is injected only when live git is enabled** (`git.dryRun === false`); dry-run / non-live paths may omit executor **`mandatePolicy`** (**G583**). Contrasts **`guru self-build-run`**, which always wires policy through **`runDevCycle`**. Headless **`POST /run`** (**G582**) and default TUI **`run`** (**G584**/**G156**) also omit executor policy unless separately fixed. |
| Self-build developer loop (`guru self-build-run`, v1.2.0) | The 0→7 spend-gated dev cycle SELECT→BUILD→TEST→SMOKE→DEBUG→REVIEW→SHIP→LEARN: mandate/spend policy is injected into the executor runtime (spend/destructive escalate **even in YOLO**); TEST runs the project's **own discovered gates** (never assumed); DEBUG parses gate output → re-plans, budget-bounded; REVIEW is guru's **live native critic panel** (RED blocks ship); SHIP routes the push through the gate and degrades to a durable on-disk change-record when git is absent; SELECT scoring + LEARN write-back close the loop (cross-run outcome persistence pending — `planning/SELF-BUILD-LOOP-HARDENING.md`); **`approvalLedger`** can record mandate decisions and persist to disk when wired into `runDevCycle` (default CLI path pending). `--dry-run` prints the stage plan only (executes nothing; plan may understate wired SMOKE/REVIEW until **G323** is fixed — see `planning/SELF-BUILD-DEVELOPER-LOOP.md`); `--loop` drives multiple tasks in one process. Every model loop is bounded by attempt cap, token budget, wall-clock, and a `$0`-denies-all spend ceiling. |

## The plan (where this is going)

The finished product is written down, present-tense and testable — the pillars: the naked kernel, the one frozen extension seam, native direct provider lanes, nothing-at-rest secrets, the memory organ, dynamic roles, the swarm, self-building, mandates. A line-by-line capability audit, adversarially verified, drives the build order:

- **P0 — runtime survival: CLOSED** (v0.9.0 compaction, v0.10.0 retry + cancellation). Long and autonomous sessions no longer die.
- **P1 — daily-driver ergonomics: IN PROGRESS.** The prior “v1.0 complete” claim is retired. Existing capabilities and test counts are inputs to acceptance, not proof that normal work is dependable. Guru remains pre-GA until real target-project sessions reliably start, type, use menus and chat, operate ordinary workspace tools in YOLO, persist Markdown memory, and resume. `v1.0` is the explicit quality gate, not a routine increment.
- **P2/P3 — breadth.** Breadth work remains secondary to closing P1; it is not a substitute for daily-driver acceptance.

Explicitly **out of scope**, by design: an external routing sidecar in the loop (on-tap only), SaaS/web/multi-user/billing, and **ungoverned self-improvement** — guru mutating its own constitution or capabilities without gates (constitutionally excluded, not deferred). This is distinct from the v1.2.0 **self-build developer loop**, which is *governed* unattended execution: every stage is mandate- and review-gated, RED blocks ship, and spend is a hard edge YOLO cannot lift — the constitution runs the loop, the loop never edits the constitution.

## Theme

The look is operator-owned: drop hex tokens into `~/.guruharness/theme.json` (see `assets/default-theme.json` for the schema). Truecolor first, honest fallbacks, `NO_COLOR` respected everywhere. Brand palette deliberately avoids stock terminal green/yellow/blue/cyan. Workspace design reference: [`../terminal-design-system/README.md`](../terminal-design-system/README.md).

## Development

```bash
npm ci
npm run typecheck && npm run build && npm test
pwsh -NoProfile -File scripts/verify-repo.ps1      # repo hygiene gate (powershell.exe on Windows)
node scripts/render-readme-shots.mjs               # regenerate the README screenshots from the real renderer
```

- Design records and coordination docs live in the workspace `archive/` tree and `../handoffs/` — workspace hub [`../README.md`](../README.md); see `planning/README.md`, `../handoffs/README.md`, [doc-control loop](../handoffs/DOCUMENT-CONTROL-LOOP.md) (`../handoffs/doc-control/README.md` · `../handoffs/doc-control/STATE.md`). Doc-vs-built gap index: [`../gaps/README.md`](../gaps/README.md) (scheduler `019f6329792d`; indexed pass **181**; guru-vs-matrix `019f64f0454b` pass **74**). Harness cross-compare matrix: [`../handoffs/harness-matrix/README.md`](../handoffs/harness-matrix/README.md) (pass **77**). Dogfood checklist: [`../handoffs/DOGFOOD-CHECKLIST-v1.5.0.md`](../handoffs/DOGFOOD-CHECKLIST-v1.5.0.md) (mandate paths **G765**/**G766**). Shipped skills: `skills/README.md`. Tests: `tests/README.md`. Review handoffs: [`../handoffs/code-reviews/INDEX.md`](../handoffs/code-reviews/INDEX.md) (PR #37 **merged** · PR #38 **`2308Z`** @ **`876e011`** · PR #39 **`0013Z`** @ `9d63835`; recheck **`2349Z`**; INDEX pass-**529**; doc-control pass-**531**).
- Dependabot watches Actions/npm weekly; its PRs may auto-approve and queue for auto-merge, but branch protection and CI still gate the merge.

## Safety boundaries

- No secrets in git; credential presence by env NAME / file PRESENCE only — values are never read, printed, or logged. The encrypted vault stores values as ciphertext (AES-256-GCM) and never surfaces them; listings are names-only.
- Resolved credential values live in process memory, non-enumerable, registered with the scrubber; compaction summaries are scrubbed both directions and again at the disk boundary.
- Mutating tools run under **YOLO by default** (guru's baseline); engage **safe mode** (`/yolo off`) for per-call prompts (`y`/always/deny), or scope with a standing `/mandate`; model writes are contained to the session repo; **hard edges always prompt, in every mode**.
- **Paired-build builder lanes** (see `AGENTS.md`): implement and hand off evidence locally — the **code-reviewer** lane commits, pushes, and opens PRs after review. No force-merges, no branch-protection bypasses, no unrelated live-system mutation.
- No GREEN handoff for repo mutations without review evidence or an explicit blocker.

## Runtime internals

The interactive `guru` surface sits on a schema-first runtime (all contracts are Zod schemas with inferred types — verdicts, tool results, done packets re-exported from `src/index.ts`):

- **Tool registry** (`src/tools/registry.ts`): normalized observations for repo, validation, review, git/PR, file, shell, memory, swarm, resolver, and operational actions; tools register per session, a curated subset is offered to models.
- **Session envelope**: `npm run cli -- session-start` assembles task, direction, config, repo/AGENTS.md chain, skills, memory binding, policy, and tools. Sessions persist and resume (`runtime.resumeSession`).
- **Planner/executor**: `npm run cli -- run` drives planner → validation/review gates → optional git/PR automation → done packet. No planner means an honest blocked report, never fake planning.
- **Compaction engine** (`src/compaction/`): pure + injectable (estimator, summarizer, clock); the REPL wires the connected route as the summary lane.
- **Retry policy** (`src/model/retryPolicy.ts`): classification, exponential backoff + jitter, Retry-After honor with a fail-fast cap; wraps every provider request in the agent turn loop.
- **Readiness proof**: the CLI prints a capability report (runtime, repo context, tools, provider routing, extension host).

Runtime policy loads from `guruharness.config.json` (`guruharness.config.example.json` is the non-secret template) — including `compaction.*`, `retry.*`, `swarm.*`, and `lookahead.*`. For self-build git automation, prefer **`approvalPolicy.autoCommitPushPr`: false** in new configs (live push requires explicit opt-in + mandate); see `../gaps/README.md` (**G253**/**G438**) if the repo default differs. Headless **`POST /run`** and the standalone TUI **`run`** command do not inject executor **`mandatePolicy`**; CLI **`guru run`** injects **`failClosedMandatePolicy`** only when **live git** is enabled — otherwise those paths may omit policy (**G582**/**G583**/**G584**/**G459**). **`guru self-build-run`** / **`runDevCycle`** inject fail-closed policy by default.

## Self-build loop

A bounded self-build scaffold selects dependency-ready tasks with direction evidence and keeps validation/review/PR gates in front of every repository change. It is a construction mechanism, not the product definition.

**Operator CLI:** `guru self-build-run` drives the 0→7 dev cycle (`--dry-run` stage plan only, `--loop` for multi-task). Details: `planning/SELF-BUILD-DEVELOPER-LOOP.md` · open seams: `../gaps/README.md` (e.g. **G52**, **G323**/**G121**, **G266**).
