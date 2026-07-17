import { spawnSync } from "node:child_process";

import { scrubSecretValues } from "../safety/secretSafety.js";

export interface VirtualReferenceProviders {
  sessionSummary(id: string): Promise<string | null>;
  memoryFacts(query: string): Promise<string | null>;
  stagedDiff(repoRoot: string): Promise<string | null>;
  terminalTail(): Promise<string | null>;
}

export interface VirtualReferencePickerSuggestion {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

export const STATIC_VIRTUAL_REFERENCES: readonly VirtualReferencePickerSuggestion[] = [
  { value: "@session:", label: "@session:", hint: "saved conversation" },
  { value: "@memory:", label: "@memory:", hint: "selected-provider facts" },
  { value: "@git-changes", label: "@git-changes", hint: "staged Git diff" },
  { value: "@terminal", label: "@terminal", hint: "recent successful bash output" }
];

export interface SessionReferenceSnapshot {
  readonly branchSummary?: string;
  readonly compactionSummary?: string;
  readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
}

export interface SessionReferenceSummaryOptions {
  readonly maxChars?: number;
  readonly maxMessages?: number;
}

const DEFAULT_SESSION_CHARS = 16 * 1024;
const DEFAULT_SESSION_MESSAGES = 12;
const DEFAULT_REFERENCE_BYTES = 50 * 1024;

function boundedTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const marker = "…\n";
  if (maxChars <= marker.length) return text.slice(-maxChars);
  return `${marker}${text.slice(-(maxChars - marker.length))}`;
}

/** Deterministic, model-free summary selection for @session:<id>. */
export function buildSessionReferenceSummary(
  snapshot: SessionReferenceSnapshot,
  options: SessionReferenceSummaryOptions = {}
): string | null {
  const maxChars = Math.max(0, options.maxChars ?? DEFAULT_SESSION_CHARS);
  const preferred = snapshot.branchSummary?.trim() || snapshot.compactionSummary?.trim();
  if (preferred) {
    return boundedTail(preferred, maxChars);
  }
  const maxMessages = Math.max(0, options.maxMessages ?? DEFAULT_SESSION_MESSAGES);
  if (maxMessages === 0) return null;
  const tail = snapshot.messages
    .filter((message): message is { readonly role: "user" | "assistant"; readonly content: string } => message.role !== "system")
    .slice(-maxMessages)
    .map((message) => `${message.role}: ${message.content.trim()}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n\n");
  return tail.length > 0 ? boundedTail(tail, maxChars) : null;
}

export type StagedGitDiffRunner = (
  executable: "git",
  argv: readonly ["diff", "--cached", "--no-ext-diff", "--"],
  cwd: string
) => Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> | {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const defaultStagedGitRunner: StagedGitDiffRunner = (executable, argv, cwd) => {
  const result = spawnSync(executable, [...argv], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
};

/** The only Git read used by @git-changes; argv is fixed and never interpolated. */
export async function readStagedGitDiff(repoRoot: string, runner: StagedGitDiffRunner = defaultStagedGitRunner): Promise<string | null> {
  const result = await runner("git", ["diff", "--cached", "--no-ext-diff", "--"], repoRoot);
  if (result.status !== 0) return null;
  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
}

/** Append one successful bash stdout value to the ephemeral capped session tail. */
export function appendTerminalTail(previous: string, stdout: string, maxBytes = 32 * 1024): string {
  if (maxBytes <= 0) return "";
  const separator = previous.length > 0 && stdout.length > 0 ? "\n" : "";
  const combined = Buffer.from(`${previous}${separator}${stdout}`, "utf8");
  if (combined.length <= maxBytes) return combined.toString("utf8");
  let tail = combined.subarray(combined.length - maxBytes).toString("utf8");
  while (Buffer.byteLength(tail, "utf8") > maxBytes) tail = tail.slice(1);
  return tail;
}

export interface VirtualReference {
  readonly raw: string;
  readonly rel: string;
  readonly index: number;
}

export interface ResolveVirtualReferenceOptions {
  readonly repoRoot: string;
  readonly providers: VirtualReferenceProviders;
  readonly maxReferenceBytes?: number;
  readonly estimateTokens: (text: string) => number;
}

export type ResolvedVirtualReference =
  | { readonly block: string; readonly tokens: number; readonly notice?: string }
  | { readonly skip: string };

export function isVirtualReference(rel: string): boolean {
  return rel === "git-changes" || rel === "terminal" || /^session:.+/u.test(rel) || /^memory:.+/u.test(rel);
}

function unavailableNotice(ref: VirtualReference): string {
  if (ref.rel.startsWith("session:")) return `${ref.raw} skipped: session not found`;
  if (ref.rel.startsWith("memory:")) return `${ref.raw} skipped: no matching memory facts`;
  if (ref.rel === "git-changes") return `${ref.raw} skipped: no staged changes available`;
  return `${ref.raw} skipped: no successful bash output available`;
}

function truncateBytes(content: string, maxBytes: number, raw: string): { readonly content: string; readonly truncated: boolean } {
  const source = Buffer.from(content, "utf8");
  if (source.length <= maxBytes) return { content, truncated: false };
  const headBytes = Math.floor(maxBytes * 0.66);
  const tailBytes = maxBytes - headBytes;
  const head = source.subarray(0, headBytes).toString("utf8");
  const tail = source.subarray(source.length - tailBytes).toString("utf8");
  return {
    content: `${head}\n… [${raw}: ${source.length - maxBytes} bytes truncated] …\n${tail}`,
    truncated: true
  };
}

export async function resolveVirtualReference(
  ref: VirtualReference,
  options: ResolveVirtualReferenceOptions
): Promise<ResolvedVirtualReference> {
  let content: string | null = null;
  if (ref.rel.startsWith("session:")) {
    content = await options.providers.sessionSummary(ref.rel.slice("session:".length));
  } else if (ref.rel.startsWith("memory:")) {
    content = await options.providers.memoryFacts(ref.rel.slice("memory:".length));
  } else if (ref.rel === "git-changes") {
    content = await options.providers.stagedDiff(options.repoRoot);
  } else if (ref.rel === "terminal") {
    content = await options.providers.terminalTail();
  }
  if (!content || content.trim().length === 0) {
    return { skip: unavailableNotice(ref) };
  }

  const maxBytes = Math.max(1, options.maxReferenceBytes ?? DEFAULT_REFERENCE_BYTES);
  const bounded = truncateBytes(scrubSecretValues(content), maxBytes, ref.raw);
  const block = scrubSecretValues(`\n\n\`\`\`\`\`virtual/${ref.rel}\n${bounded.content}\n\`\`\`\`\`\n`);
  return {
    block,
    tokens: options.estimateTokens(block),
    ...(bounded.truncated
      ? { notice: `${ref.raw} truncated to ~${Math.max(1, Math.round(maxBytes / 1024))}KB (head+tail)` }
      : {})
  };
}
