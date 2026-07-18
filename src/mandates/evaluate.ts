import { resolve } from "node:path";

import { HARD_EDGE_VERBS, type MandateState, type MandateVerb } from "./schema.js";

/**
 * Maps a tool id + input to the verbs it exercises. Read-only tools imply no
 * gated verb (they are always allowed). Everything else declares what it does so
 * the mandate can reason about it.
 */
const TOOL_VERBS: Readonly<Record<string, readonly MandateVerb[]>> = {
  bash: ["exec"],
  "shell.command.run": ["exec"],
  edit: ["write"],
  write: ["write"],
  "fs.edit.apply": ["write"],
  memory_remember: ["write"],
  memory_forget: ["write"],
  memory_doctor: ["write"],
  "operational.state.write": ["write"],
  "operational.decision.upsert": ["write"],
  "operational.backlog.create": ["write"],
  "operational.implementation.create": ["write"],
  "operational.blocker.record": ["write"],
  "git.pr.run": ["net", "exec"],
  "github.pr.comment": ["net"],
  "github.pr.review": ["net"],
  "review.gates.run": ["exec"],
  honcho_remember: ["write", "net"],
  honcho_log_turn: ["write", "net"],
  // The swarm trio is permission-NEUTRAL: spawning delegates no authority — the
  // WORKER's own approval policy gates every action it takes (read-only scouts
  // physically cannot mutate; "all" workers share the live session policy
  // per-call). Gating spawn itself would double-gate without adding safety.
  spawn_agent: [],
  get_task_output: [],
  kill_task: [],
  // Probe-only (registry lookups + PATH presence): never mutates.
  resolve_capability_gap: [],
  // Session task board — process memory only, never disk secrets.
  todo_write: [],
  todo_list: [],
  // Operator Q&A — no mutation.
  ask_question: [],
  // MCP meta-dispatch: discovery is read-only; dispatch is conservatively write-gated.
  search_tool: [],
  use_tool: ["write"],
  // MCP attach board — read-only snapshot.
  mcp_bridge_status: [],
  // Networked research (bounded).
  web_fetch: ["net"],
  web_search: ["net"],
  // Provider CLI matrix is a PATH/env-name probe only.
  provider_cli_status: [],
  // Live delegated CLI may shell out (and often spend via provider plans).
  provider_cli_run: ["exec"],
  // Desktop: status is probe-only; mutations escalate (live path still needs userApproved).
  pyautogui_status: [],
  pyautogui_screen: [],
  pyautogui_mouse: ["exec"],
  pyautogui_keyboard: ["exec"],
  // Cursor-parity local tools (wave 2026-07-10) — no mutation.
  read_diagnostics: [],
  manage_task: [],
  monitor: []
};

/** Read-only tools: never gated by the mandate (the always-allowed floor). */
export const MANDATE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "repo.context.resolve",
  "skills.catalog.list",
  "skill.document.load",
  "memory_search",
  "memory_get",
  "memory_status",
  "honcho_memory_status",
  "honcho_recall",
  "honcho_context",
  "todo_list",
  "ask_question",
  "search_tool",
  "mcp_bridge_status",
  "provider_cli_status",
  "pyautogui_status",
  "service_readiness_report",
  "operational.project.get",
  "operational.state.list",
  "operational.backlog.list",
  "github.pr.status",
  "read_diagnostics",
  "monitor",
  "lsp"
]);

/**
 * Non-rm destructive shell forms. `rm` is handled by {@link isDestructiveRm}
 * so split/long flags (`rm -r -f`, `rm --recursive --force`) escalate the same
 * way as the classic `rm -rf` cluster. Windows recursive deletes are handled by
 * {@link isDestructiveWindowsDelete} (YOLO silent-allow hole on this host).
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  // Force-push: --force (not the safer --force-with-lease).
  /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i,
  // Force-push short form: `git push -f` / `git push origin main -f`.
  /\bgit\s+push\b(?:\s+\S+)*?\s+-f(?:\s|$)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(mkfs|dd\s+if=|:\(\)\s*\{)/i,
  /\bshutdown\b|\breboot\b/i
];

/**
 * True when a shell command is a recursive+force `rm` in any common flag shape:
 * `rm -rf`, `rm -fr`, `rm -r -f`, `rm -f -r`, `rm --recursive --force`.
 * Recursive alone (`rm -r`) is NOT destructive-class (no force).
 */
export function isDestructiveRm(command: string): boolean {
  if (!/\brm\b/i.test(command)) {
    return false;
  }
  // Scan tokens after the first `rm` until a non-flag path argument.
  const tokens = command.split(/\s+/u).filter((t) => t.length > 0);
  const rmAt = tokens.findIndex((t) => t.toLowerCase() === "rm");
  if (rmAt < 0) {
    return false;
  }
  let recursive = false;
  let force = false;
  for (let i = rmAt + 1; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "--") {
      break;
    }
    if (token.startsWith("--")) {
      const long = token.toLowerCase();
      if (long === "--recursive" || long === "--dir" || long === "--directory") {
        recursive = true;
      } else if (long === "--force") {
        force = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      // Short cluster: -rf / -fr / -R / -f / -rF etc.
      const letters = token.slice(1);
      if (/[rR]/u.test(letters)) {
        recursive = true;
      }
      if (/[fF]/u.test(letters)) {
        force = true;
      }
      continue;
    }
    // First non-flag token is the path/target — stop scanning flags.
    break;
  }
  return recursive && force;
}

/**
 * Windows / PowerShell recursive-delete shapes that must escalate like `rm -rf`.
 * Under YOLO-by-default these were silent-allow (only Unix `rm` was hard-edged),
 * so a model running on this Windows host could wipe trees without a prompt.
 *
 * Covered:
 * - `del /s /q …`, `del /f /s /q …`
 * - `rmdir /s /q …`, `rd /s /q …`
 * - `Remove-Item -Recurse -Force …` (and `-r` / `-fo` short forms)
 * - `ri -r -fo …` (Remove-Item alias)
 */
export function isDestructiveWindowsDelete(command: string): boolean {
  // cmd.exe: del/erase with /S (recurse) — quiet or not, the tree is wiped.
  if (/\b(?:del|erase)\b/i.test(command) && /\/s\b/i.test(command)) {
    return true;
  }
  // cmd.exe: rmdir/rd with /S.
  if (/\b(?:rmdir|rd)\b/i.test(command) && /\/s\b/i.test(command)) {
    return true;
  }
  // PowerShell Remove-Item / ri: recurse + force in any flag shape.
  if (/\b(?:remove-item|ri)\b/i.test(command)) {
    const recurse = /(?:-recurse\b|-r\b)/i.test(command);
    const force = /(?:-force\b|-fo\b)/i.test(command);
    if (recurse && force) {
      return true;
    }
  }
  return false;
}

function isDestructiveCommand(command: string): boolean {
  return (
    isDestructiveRm(command) ||
    isDestructiveWindowsDelete(command) ||
    DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))
  );
}

/** Secrets-adjacent file targets (.env, keys, npm auth, credentials). */
// The boundary class includes shell redirects `>` and pipe `|` so `echo x>.env`,
// `echo x>>.env`, and `cmd|tee .env` are detected as secret-edge writes (F5).
const SECRET_PATH_PATTERN = /(^|[\s/\\'"=>|])(\.env(\.[\w-]+)?|[\w.-]*\.pem|[\w.-]*\.key|id_rsa|id_ed25519|\.npmrc|credentials|\.pgpass|\.htpasswd)(\b|$)/i;
/** Ecosystem auth files (cloud/provider CLI token + config stores). */
const AUTH_PATH_PATTERN = /(\.aws[/\\]credentials|\.config[/\\]gh|\.codex|\.config[/\\]gcloud|\.docker[/\\]config|\.kube[/\\]config|\.netrc|\.ssh[/\\])/i;
/** A shell command that WRITES (as opposed to merely reading) a path. */
const SHELL_WRITE_INTENT = /(>>?|\btee\b|\bcp\b|\bmv\b|\binstall\b|\bdd\b|\bchmod\b|\bchown\b|\bln\s+-s)/i;

/**
 * Commands that MOVE MONEY or provision BILLABLE resources — the `spend` hard edge
 * (§2.3). High-precision by design: a coding session rarely runs these, so a match
 * is a genuine spend signal, and the safe direction is to prompt. Read-only cloud
 * calls (`aws s3 ls`, `gcloud config set`) deliberately do NOT match — only the
 * provisioning / deploy / payment verbs do.
 */
const SPEND_PATTERNS: readonly RegExp[] = [
  /\bterraform\s+(apply|destroy)\b/i, // provision / tear down billable infra
  /\bpulumi\s+(up|destroy)\b/i,
  /\bfly(ctl)?\s+deploy\b/i, // paid PaaS deploys
  /\brailway\s+up\b/i,
  /\bheroku\s+(create|ps:scale|addons:(create|add))\b/i,
  /\b(vercel|netlify)\b[^\n]*--prod\b/i, // production (billable) deploy
  /\baws\s+[a-z0-9-]+\s+(run-instances|start-instances|create-[a-z-]+|purchase-[a-z-]+)\b/i,
  /\b(gcloud|az)\s+[a-z0-9-]+\s+[a-z0-9 -]*?\bcreate\b/i, // create a cloud resource
  /\bstripe\b[^\n]*\b(charges?|payment_intents?|subscriptions?|invoices?|payouts?)\b/i // payments
];

/**
 * Baseline network destinations (G1055-P1): ordinary `net` that must NEVER
 * escalate to the `spend` hard edge. The table is intentionally tiny and exact:
 *
 * - loopback hosts (`localhost`, `127.0.0.1`, `::1`) — local, non-billable targets;
 * - `html.duckduckgo.com` — the FIXED endpoint the `web_search` builtin owns.
 *
 * Every other network host is treated as external/unrecognized and carries
 * `spend`, so a non-baseline destination cannot silently ride under `net` and
 * bypass the unliftable spend edge (even under YOLO). Matching is EXACT after
 * {@link normalizeNetHost}: there is no suffix logic, so `evilduckduckgo.com`
 * and `html.duckduckgo.com.attacker.example` are correctly non-baseline.
 */
const BASELINE_NET_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "html.duckduckgo.com"]);

/** The fixed, tool-owned `web_search` endpoint host (already normalized). */
const WEB_SEARCH_ENDPOINT_HOST = "html.duckduckgo.com";

/**
 * Explicit HTTP(S) URL candidates embedded in a shell command string. Shell
 * escapes, quotes, and substitutions remain part of the match so ambiguity fails
 * closed instead of silently classifying only a safe-looking prefix. ssh/scp,
 * bare hostnames, and DNS names are out of scope for this slice.
 */
const SHELL_URL_PATTERN = /\bhttps?:\/\/[^\s<>|)]+/giu;

interface ShellWord {
  /** Quote delimiters removed and backslash escapes collapsed; never executed. */
  readonly text: string;
  /** True when this word contains an unquoted or double-quoted shell expansion. */
  readonly hasExpansion: boolean;
}

type ShellNetworkClient = "curl" | "wget";

const CURL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--cacert",
  "--cert",
  "--config",
  "--connect-timeout",
  "--cookie",
  "--cookie-jar",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "--form",
  "--header",
  "--key",
  "--max-time",
  "--output",
  "--referer",
  "--request",
  "--upload-file",
  "--user",
  "--user-agent",
  "--write-out"
]);

const CURL_DESTINATION_OPTIONS: ReadonlySet<string> = new Set([
  "--connect-to",
  "--preproxy",
  "--proxy",
  "--resolve",
  "--url"
]);

/** Options whose file operand supplies one or more destinations at runtime. */
const CURL_DESTINATION_SOURCE_OPTIONS: ReadonlySet<string> = new Set(["--config"]);

const CURL_SHORT_OPTIONS_WITH_VALUE = new Set(["A", "b", "c", "C", "d", "D", "e", "E", "F", "H", "K", "m", "o", "Q", "r", "t", "T", "u", "w", "X"]);
const CURL_SHORT_DESTINATION_OPTIONS = new Set(["x"]);
const CURL_SHORT_DESTINATION_SOURCE_OPTIONS = new Set(["K"]);

const WGET_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--body-data",
  "--body-file",
  "--directory-prefix",
  "--header",
  "--output-document",
  "--output-file",
  "--post-data",
  "--post-file",
  "--timeout",
  "--tries",
  "--user-agent"
]);

const WGET_SHORT_OPTIONS_WITH_VALUE = new Set(["a", "d", "e", "o", "O", "P", "t", "T", "U"]);
const WGET_DESTINATION_SOURCE_OPTIONS: ReadonlySet<string> = new Set(["--input-file"]);
const WGET_SHORT_DESTINATION_SOURCE_OPTIONS = new Set(["i"]);

/**
 * Lowercases a hostname, strips IPv6 brackets, and removes a single terminal dot
 * so comparison against {@link BASELINE_NET_HOSTS} is exact and case/FQDN-stable
 * (`[::1]` -> `::1`, `LocalHost.` -> `localhost`). It never collapses suffixes.
 */
function normalizeNetHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host;
}

/**
 * Extracts the normalized network host from a candidate URL value WITHOUT doing
 * any I/O. Returns `undefined` for a non-string, empty, non-HTTP(S), hostless, or
 * otherwise unparseable value so the caller can fail closed with `spend`.
 */
function netHostFromUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  if (parsed.hostname.length === 0) {
    return undefined;
  }
  return normalizeNetHost(parsed.hostname);
}

/**
 * Records a network destination on the verb set: always `net`, plus `spend` when
 * the host is missing/malformed (`undefined`) or outside {@link BASELINE_NET_HOSTS}.
 * Fail-closed by design — an unknown destination is treated as external/billable.
 */
function addNetDestination(host: string | undefined, verbs: Set<MandateVerb>): void {
  verbs.add("net");
  if (host === undefined || !BASELINE_NET_HOSTS.has(host)) {
    verbs.add("spend");
  }
}

function startsShellExpansion(next: string | undefined): boolean {
  return next !== undefined && (next === "{" || next === "(" || /[a-z0-9_@*#?!$-]/iu.test(next));
}

/**
 * Splits shell text into command-segment words without executing or expanding it.
 * Quoted whitespace remains in a word, single-quoted `$` stays literal, and an
 * unquoted/double-quoted parameter expansion is retained as an explicit bit.
 * Shell list/pipeline/subshell operators terminate a segment, which makes client
 * detection independent of byte-zero anchoring.
 */
function shellCommandSegments(command: string): readonly (readonly ShellWord[])[] {
  const segments: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let text = "";
  let hasExpansion = false;
  let wordStarted = false;
  let quote: "single" | "double" | undefined;

  const flushWord = (): void => {
    if (!wordStarted) return;
    words.push({ text, hasExpansion });
    text = "";
    hasExpansion = false;
    wordStarted = false;
  };
  const flushSegment = (): void => {
    flushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (quote === "single") {
      wordStarted = true;
      if (char === "'") quote = undefined;
      else text += char;
      continue;
    }

    if (char === "'" && quote !== "double") {
      wordStarted = true;
      quote = "single";
      continue;
    }
    if (char === '"') {
      wordStarted = true;
      quote = quote === "double" ? undefined : "double";
      continue;
    }

    if (char === "\\") {
      wordStarted = true;
      if (index + 1 < command.length) {
        const escaped = command[index + 1]!;
        // POSIX line continuation removes both bytes before tokenization.
        // Keeping the newline inside the word hid command positions such as
        // `c\\\nurl`; removing it mirrors the shell's lexical boundary without
        // executing or expanding anything.
        if (escaped !== "\n" && escaped !== "\r") text += escaped;
        index += 1;
      } else {
        text += char;
      }
      continue;
    }

    if (char === "$" && startsShellExpansion(command[index + 1])) {
      wordStarted = true;
      hasExpansion = true;
      if (command[index + 1] === "{") {
        const close = command.indexOf("}", index + 2);
        if (close >= 0) {
          text += command.slice(index, close + 1);
          index = close;
          continue;
        }
      }
      text += char;
      continue;
    }

    if (quote !== "double" && /[\t\r ]/u.test(char)) {
      flushWord();
      continue;
    }
    if (quote !== "double" && (char === "{" || char === "}")) {
      wordStarted = true;
      hasExpansion = true;
      text += char;
      continue;
    }
    if (quote !== "double" && (char === "\n" || /[;&|()]/u.test(char))) {
      flushSegment();
      continue;
    }

    wordStarted = true;
    text += char;
  }

  flushSegment();
  return segments;
}

function shellCommandBasename(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return (normalized.slice(normalized.lastIndexOf("/") + 1) || normalized).toLowerCase();
}

function isShellAssignment(value: string): boolean {
  return /^[a-z_][a-z0-9_]*=/iu.test(value);
}

function addUnknownDestinationIfExpanded(word: ShellWord, verbs: Set<MandateVerb>): void {
  if (word.hasExpansion) addNetDestination(undefined, verbs);
}

/**
 * Distinguishes client option values from destination operands. This closes the
 * hard-edge bypass without treating headers/output paths as unknown hosts.
 */
function classifyShellClientArguments(
  client: ShellNetworkClient,
  args: readonly ShellWord[],
  verbs: Set<MandateVerb>,
  receivesUnknownArguments: boolean
): void {
  if (receivesUnknownArguments) addNetDestination(undefined, verbs);

  let pending: "destination" | "non-destination" | undefined;
  let optionsEnded = false;
  for (const word of args) {
    if (pending) {
      if (pending === "destination") addUnknownDestinationIfExpanded(word, verbs);
      pending = undefined;
      continue;
    }

    if (!optionsEnded && word.text === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && word.text.startsWith("--")) {
      const equals = word.text.indexOf("=");
      const option = equals >= 0 ? word.text.slice(0, equals) : word.text;
      const inline = equals >= 0;
      const isDestinationSource =
        (client === "curl" && CURL_DESTINATION_SOURCE_OPTIONS.has(option)) ||
        (client === "wget" && WGET_DESTINATION_SOURCE_OPTIONS.has(option));
      if (isDestinationSource) {
        addNetDestination(undefined, verbs);
        if (!inline) pending = "non-destination";
      } else if (client === "curl" && CURL_DESTINATION_OPTIONS.has(option)) {
        if (inline) addUnknownDestinationIfExpanded(word, verbs);
        else pending = "destination";
      } else if (
        (client === "curl" && CURL_OPTIONS_WITH_VALUE.has(option)) ||
        (client === "wget" && WGET_OPTIONS_WITH_VALUE.has(option))
      ) {
        if (!inline) pending = "non-destination";
      }
      continue;
    }

    if (!optionsEnded && word.text.startsWith("-") && word.text !== "-") {
      const valueOptions = client === "curl" ? CURL_SHORT_OPTIONS_WITH_VALUE : WGET_SHORT_OPTIONS_WITH_VALUE;
      for (let optionIndex = 1; optionIndex < word.text.length; optionIndex += 1) {
        const option = word.text[optionIndex]!;
        const isDestinationSource =
          (client === "curl" && CURL_SHORT_DESTINATION_SOURCE_OPTIONS.has(option)) ||
          (client === "wget" && WGET_SHORT_DESTINATION_SOURCE_OPTIONS.has(option));
        if (isDestinationSource) {
          addNetDestination(undefined, verbs);
          if (optionIndex + 1 === word.text.length) pending = "non-destination";
          break;
        }
        if (client === "curl" && CURL_SHORT_DESTINATION_OPTIONS.has(option)) {
          if (optionIndex + 1 < word.text.length) addUnknownDestinationIfExpanded(word, verbs);
          else pending = "destination";
          break;
        }
        if (valueOptions.has(option)) {
          if (optionIndex + 1 === word.text.length) pending = "non-destination";
          break;
        }
      }
      continue;
    }

    addUnknownDestinationIfExpanded(word, verbs);
  }
}

const SHELL_EXECUTION_DEPTH_LIMIT = 8;

function skipShellOptions(
  words: readonly ShellWord[],
  start: number,
  optionsWithSeparateValue: ReadonlySet<string> = new Set()
): number {
  let index = start;
  while (words[index]) {
    const word = words[index]!;
    if (word.text === "--") return index + 1;
    if (word.hasExpansion || word.text === "-" || !word.text.startsWith("-")) return index;
    const equals = word.text.indexOf("=");
    const option = equals >= 0 ? word.text.slice(0, equals) : word.text;
    index += 1;
    if (equals < 0 && optionsWithSeparateValue.has(option) && words[index]) index += 1;
  }
  return index;
}

function classifyDelegatedShellText(
  scriptWords: readonly ShellWord[],
  verbs: Set<MandateVerb>,
  depth: number
): void {
  if (scriptWords.length === 0) return;
  if (scriptWords.some((word) => word.hasExpansion)) {
    addNetDestination(undefined, verbs);
    return;
  }
  const script = scriptWords.map((word) => word.text).join(" ").trim();
  if (script.length > 0) classifyShellExecutionBoundary(script, verbs, depth + 1);
}

/**
 * Classifies only executable positions. Literal command arguments remain data;
 * expansion-backed executable slots at known execution/delegation boundaries
 * fail closed because their eventual network behavior cannot be established
 * without running the shell.
 */
function classifyShellExecutable(
  words: readonly ShellWord[],
  start: number,
  verbs: Set<MandateVerb>,
  depth: number,
  receivesUnknownArguments = false
): void {
  if (depth >= SHELL_EXECUTION_DEPTH_LIMIT) {
    addNetDestination(undefined, verbs);
    return;
  }

  let index = start;
  while (words[index] && isShellAssignment(words[index]!.text)) index += 1;
  const executable = words[index];
  if (!executable) return;
  if (executable.hasExpansion) {
    addNetDestination(undefined, verbs);
    return;
  }

  const command = shellCommandBasename(executable.text);
  if (command === "curl" || command === "wget") {
    classifyShellClientArguments(command, words.slice(index + 1), verbs, receivesUnknownArguments);
    return;
  }

  if (command === "command") {
    const next = index + 1;
    if (words[next]?.text === "-v" || words[next]?.text === "-V") return;
    classifyShellExecutable(words, skipShellOptions(words, next), verbs, depth + 1, receivesUnknownArguments);
    return;
  }

  if (command === "env") {
    index += 1;
    while (words[index]) {
      const option = words[index]!;
      if (isShellAssignment(option.text)) {
        index += 1;
        continue;
      }
      if (option.text === "-S" || option.text === "--split-string") {
        classifyDelegatedShellText(words.slice(index + 1, index + 2), verbs, depth);
        return;
      }
      if (option.text.startsWith("--split-string=")) {
        classifyDelegatedShellText(
          [{ text: option.text.slice("--split-string=".length), hasExpansion: option.hasExpansion }],
          verbs,
          depth
        );
        return;
      }
      if (option.text === "--") {
        index += 1;
        break;
      }
      if (!option.text.startsWith("-") || option.text === "-" || option.hasExpansion) break;
      const consumesNext = option.text === "-u" || option.text === "--unset" || option.text === "-C" || option.text === "--chdir";
      index += consumesNext ? 2 : 1;
    }
    classifyShellExecutable(words, index, verbs, depth + 1, receivesUnknownArguments);
    return;
  }

  if (command === "exec") {
    const next = skipShellOptions(words, index + 1, new Set(["-a"]));
    classifyShellExecutable(words, next, verbs, depth + 1, receivesUnknownArguments);
    return;
  }

  if (command === "nohup" || command === "time") {
    const values = command === "time" ? new Set(["-f", "--format", "-o", "--output"]) : new Set<string>();
    classifyShellExecutable(words, skipShellOptions(words, index + 1, values), verbs, depth + 1, receivesUnknownArguments);
    return;
  }

  if (command === "timeout") {
    const afterOptions = skipShellOptions(words, index + 1, new Set(["-s", "--signal", "-k", "--kill-after"]));
    classifyShellExecutable(words, afterOptions + (words[afterOptions] ? 1 : 0), verbs, depth + 1, receivesUnknownArguments);
    return;
  }

  if (command === "nice") {
    classifyShellExecutable(
      words,
      skipShellOptions(words, index + 1, new Set(["-n", "--adjustment"])),
      verbs,
      depth + 1,
      receivesUnknownArguments
    );
    return;
  }

  if (command === "stdbuf") {
    classifyShellExecutable(
      words,
      skipShellOptions(words, index + 1, new Set(["-i", "--input", "-o", "--output", "-e", "--error"])),
      verbs,
      depth + 1,
      receivesUnknownArguments
    );
    return;
  }

  if (command === "setsid" || command === "busybox") {
    classifyShellExecutable(words, skipShellOptions(words, index + 1), verbs, depth + 1, receivesUnknownArguments);
    return;
  }

  if (command === "xargs") {
    const next = skipShellOptions(
      words,
      index + 1,
      new Set(["-a", "--arg-file", "-E", "--eof", "-I", "--replace", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"])
    );
    if (words[next]) classifyShellExecutable(words, next, verbs, depth + 1, true);
    return;
  }

  if (command === "find") {
    for (let cursor = index + 1; cursor < words.length; cursor += 1) {
      if (words[cursor]!.text === "-exec" || words[cursor]!.text === "-execdir") {
        classifyShellExecutable(words, cursor + 1, verbs, depth + 1, receivesUnknownArguments);
      }
    }
    return;
  }

  if (command === "sh" || command === "bash") {
    for (let cursor = index + 1; cursor < words.length; cursor += 1) {
      const option = words[cursor]!;
      if (option.text === "<<<") {
        classifyDelegatedShellText(words.slice(cursor + 1, cursor + 2), verbs, depth);
        return;
      }
      if (option.text.startsWith("-") && !option.text.startsWith("--") && option.text.slice(1).includes("c")) {
        classifyDelegatedShellText(words.slice(cursor + 1, cursor + 2), verbs, depth);
        return;
      }
    }
    return;
  }

  if (command === "eval") {
    classifyDelegatedShellText(words.slice(index + 1), verbs, depth);
  }
}

function classifyShellExecutionBoundary(command: string, verbs: Set<MandateVerb>, depth = 0): void {
  for (const segment of shellCommandSegments(command)) {
    classifyShellExecutable(segment, 0, verbs, depth);
  }
}

/**
 * Deterministically removes POSIX shell escaping and quoting from a command
 * string for URL-detection purposes only. This is NOT a full shell parser; it
 * strips backslash escapes (`\X` → `X`) and single/double quote delimiters so
 * commands like `curl http:\/\/evil.com/path` and `curl h'ttp://evil.com/path'`
 * are recognized as carrying HTTP(S) destinations even when the raw string
 * contains no literal `http://` token.
 *
 * This never executes the shell. It produces a best-effort de-shelled form; when
 * the result differs from the original and reveals URLs the raw string did not,
 * {@link classifyShellNetHosts} fails closed with `spend` because the effective
 * destination cannot be established without shell execution.
 */
function shellNormalizeForUrlDetection(command: string): string {
  return command
    .replace(/\\(?:\r\n|\n|\r)/gu, "")
    .replace(/\\([\s\S])/gu, "$1")
    .replace(/["']/gu, "");
}

/**
 * Classifies every explicit HTTP(S) URL candidate found in a shell command.
 *
 * Pass 1 — raw regex: matches literal `http(s)://` tokens. Backslash or backtick
 * inside a matched token fails closed with `spend`; quote-stripped tokens are
 * parsed to determine whether the resolved host is baseline or external.
 *
 * Pass 2 — shell-normalization fallback (G1055 constitutional correction): when
 * the raw command contains no literal `http(s)://` token but deterministic
 * backslash-removal + quote-stripping produces one, the effective URL is hidden
 * behind shell syntax. The destination cannot be safely established without
 * executing the shell, so every such normalized-only match fails closed with
 * `spend` (Vision Reset §3.2).
 */
function classifyShellNetHosts(command: string, verbs: Set<MandateVerb>): void {
  // Pass 1: explicit HTTP(S) URLs visible in the raw command string.
  const matches = command.match(SHELL_URL_PATTERN) ?? [];
  for (const match of matches) {
    // POSIX shells remove single/double quote delimiters while concatenating the
    // enclosed text into one argument. Parse that effective candidate so quoted
    // userinfo cannot hide behind a baseline prefix. Backslashes and command
    // substitution remain destination-ambiguous and therefore fail closed.
    const ambiguous = match.includes("\\") || match.includes("`");
    const effectiveCandidate = match.replace(/["']/gu, "");
    addNetDestination(ambiguous ? undefined : netHostFromUrl(effectiveCandidate), verbs);
  }

  // Inspect executable positions and supported delegation boundaries. Unlike a
  // whole-command client-name count, this does not confuse ordinary data with
  // execution, while expansion-derived executables still fail closed.
  classifyShellExecutionBoundary(command, verbs);

  // Pass 2: no raw URL tokens. Apply deterministic shell normalization
  // (backslash-escape removal + quote stripping) and re-check. If the
  // normalized form contains HTTP(S) URLs not visible in the raw command,
  // the effective destination depends on shell processing → fail closed
  // with spend for every such hidden destination.
  const normalized = shellNormalizeForUrlDetection(command);
  if (normalized !== command) {
    const normalizedMatches = normalized.match(SHELL_URL_PATTERN);
    const hiddenMatchCount = Math.max(0, (normalizedMatches?.length ?? 0) - matches.length);
    if (hiddenMatchCount > 0) {
      for (let index = 0; index < hiddenMatchCount; index += 1) {
        addNetDestination(undefined, verbs);
      }
    }
  }
}

/**
 * Derives the verbs a specific tool call exercises. Escalates to "destructive" on
 * a destructive shell pattern, "spend" on a money-moving / billable-provisioning
 * command, and "secret-edge"/"auth-edge" when a WRITE targets a secrets-adjacent
 * or ecosystem-auth file (all hard edges — §2.3, prompt in every mode). Network
 * tools (`web_fetch`, `web_search`, explicit URLs in shell) also add "net", plus
 * the "spend" hard edge for any non-baseline / missing destination (G1055-P1).
 */
export function verbsForCall(toolId: string, input: unknown): readonly MandateVerb[] {
  const base = TOOL_VERBS[toolId] ?? (MANDATE_READ_ONLY_TOOLS.has(toolId) ? [] : ["write"]);
  const verbs = new Set<MandateVerb>(base);
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  if (toolId === "bash" || toolId === "shell.command.run") {
    const command = String(record.command ?? record.cmd ?? "");
    if (isDestructiveCommand(command)) {
      verbs.add("destructive");
    }
    if (SPEND_PATTERNS.some((pattern) => pattern.test(command))) {
      verbs.add("spend");
    }
    if (SHELL_WRITE_INTENT.test(command)) {
      if (SECRET_PATH_PATTERN.test(command)) verbs.add("secret-edge");
      if (AUTH_PATH_PATTERN.test(command)) verbs.add("auth-edge");
    }
    // G1055-P1: explicit HTTP(S) URLs in the command add `net`, plus the `spend`
    // hard edge for any non-baseline destination host.
    classifyShellNetHosts(command, verbs);
  } else if (toolId === "web_fetch") {
    // Parse the existing input.url without any I/O; a missing or malformed
    // destination fails closed with `spend` rather than silently baseline.
    addNetDestination(netHostFromUrl(record.url), verbs);
  } else if (toolId === "web_search") {
    // Tool-owned fixed endpoint: the model-provided query never sets the host,
    // so this stays ordinary baseline `net`.
    addNetDestination(WEB_SEARCH_ENDPOINT_HOST, verbs);
  } else if (verbs.has("write")) {
    // A write/edit tool targets a concrete path — the clearest signal.
    const path = String(record.path ?? "");
    if (SECRET_PATH_PATTERN.test(path)) verbs.add("secret-edge");
    if (AUTH_PATH_PATTERN.test(path)) verbs.add("auth-edge");
  }
  return [...verbs];
}

export type MandateOutcome = "allow" | "deny" | "escalate";

export interface MandateDecision {
  readonly outcome: MandateOutcome;
  readonly reason: string;
  /** The verbs the call was evaluated against (for surfacing). */
  readonly verbs: readonly MandateVerb[];
}

export interface MandateContext {
  readonly cwd: string;
  readonly state: MandateState;
  /** True when the operator has declared YOLO for the session. */
  readonly yolo: boolean;
}

function pathCovers(grantPath: string, target: string): boolean {
  const g = resolve(grantPath);
  const t = resolve(target);
  return t === g || t.startsWith(`${g}/`) || t.startsWith(`${g}\\`);
}

/**
 * Resolve the path a call actually touches for SPACE scoping. Prefer an explicit
 * tool path (write/edit); fall back to cwd for shell/exec (cwd-relative ops).
 * Without this, a SPACE grant was checked only against cwd — a write to an
 * absolute path outside the grant still passed while the operator sat inside
 * the granted tree (critic B13).
 */
export function resolveMandateTargetPath(toolId: string, input: unknown, cwd: string): string {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const raw =
    typeof record.path === "string" && record.path.length > 0
      ? record.path
      : typeof record.file === "string" && record.file.length > 0
        ? record.file
        : typeof record.file_path === "string" && record.file_path.length > 0
          ? record.file_path
          : "";
  if (raw.length > 0 && (toolId === "write" || toolId === "edit" || toolId === "fs.edit.apply" || toolId === "read" || toolId === "bash" || toolId === "shell.command.run")) {
    // Absolute targets resolve as-is; relative ones resolve under cwd.
    return resolve(cwd, raw);
  }

  if (toolId === "bash" || toolId === "shell.command.run") {
    const command = String(record.command ?? record.cmd ?? "");
    // Bash-under-SPACE escape via absolute/relative paths in shell string.
    // If the shell command names a path outside cwd (absolute or ../), treat it as the target.
    // (Excludes /dev/null and nul).
    const escapeMatch = command.match(/(?:^|[\s'"=|>])([a-zA-Z]:[\\/][^\s"'<>|]+|\/[^\s"'<>|]+|(?:\.\.[\\/])+[^\s"'<>|]*)/);
    if (escapeMatch && escapeMatch[1]) {
      const p = escapeMatch[1];
      if (p !== "/dev/null" && p.toLowerCase() !== "nul") {
        return resolve(cwd, p);
      }
    }
  }

  return resolve(cwd);
}

/**
 * Evaluates a tool call against the mandate. Order (THERE §2.3 Article 3):
 * read-only floor → deny-wins → HARD-EDGE escalation → YOLO → covering grant →
 * escalate. Deny and hard edges are evaluated BEFORE YOLO, so YOLO lifts
 * ordinary permission gates but NEVER a deny or a hard edge (destructive / spend
 * / secrets-adjacent-write / ecosystem-auth-file) — those still escalate in
 * every mode including YOLO.
 */
export function evaluateToolMandate(toolId: string, input: unknown, ctx: MandateContext): MandateDecision {
  const verbs = verbsForCall(toolId, input);
  const targetPath = resolveMandateTargetPath(toolId, input, ctx.cwd);

  if (verbs.length === 0) {
    return { outcome: "allow", reason: "read-only tool (always allowed)", verbs };
  }

  // Deny-wins — beats a grant AND beats YOLO.
  for (const deny of ctx.state.denies) {
    if (verbs.includes(deny.verb) && (!deny.path || pathCovers(deny.path, targetPath))) {
      return { outcome: "deny", reason: `denied by rule (${deny.verb}${deny.path ? ` in ${deny.path}` : ""})`, verbs };
    }
  }

  // Hard edges are never covered by a standing grant AND never lifted by YOLO
  // (Article 3): they escalate in every mode. The real per-call prompt is a
  // composer gap; escalate routes to the interactive/allow-writes fallthrough.
  const hardEdge = verbs.find((verb) => HARD_EDGE_VERBS.has(verb));
  if (hardEdge) {
    return { outcome: "escalate", reason: `hard edge (${hardEdge}) requires explicit confirmation in every mode — even YOLO`, verbs };
  }

  // YOLO lifts every ordinary PERMISSION gate (the self-mutation constitution +
  // secret output law live elsewhere and are unaffected).
  if (ctx.yolo) {
    return { outcome: "allow", reason: "YOLO mode: ordinary permission gates lifted (hard edges/denies still bind)", verbs };
  }

  // A covering grant that carries every required verb allows the call.
  // SPACE scope is checked against the operation TARGET, not only cwd.
  for (const grant of ctx.state.grants) {
    const inScope =
      grant.scope === "machine" || (grant.scope === "space" && grant.path !== undefined && pathCovers(grant.path, targetPath));
    if (inScope && verbs.every((verb) => grant.verbs.includes(verb))) {
      return { outcome: "allow", reason: `granted by ${grant.scope}${grant.scope === "space" ? ` (${grant.path})` : ""} mandate`, verbs };
    }
  }

  return { outcome: "escalate", reason: `no mandate covers ${verbs.join("+")} — falls through to interactive approval`, verbs };
}
