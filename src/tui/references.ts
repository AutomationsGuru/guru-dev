import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { scrubSecretValues } from "../safety/secretSafety.js";
import {
  isVirtualReference,
  resolveVirtualReference,
  type VirtualReferenceProviders
} from "./virtualReferences.js";

/**
 * @-reference content expansion (Composer Completion wave, ADR
 * 2026-07-05-composer-completion). A PURE resolver: it finds `@path` tokens in
 * the submitted text and replaces each inline with the referenced file's
 * contents — guarded against per-file blowup (50KB head/tail), window blowup
 * (80%-of-context skip), and secret leakage (scrub). No I/O beyond reading the
 * referenced files; every guard is deterministic and unit-testable.
 */

export interface ExpandReferencesOptions {
  readonly repoRoot: string;
  /** Estimated tokens already in the outgoing turn (history + system). */
  readonly baseTokens: number;
  /** The connected route's context window; expansion stays under 80% of it. */
  readonly contextWindowTokens: number;
  /** Per-file byte cap before head/tail truncation. Default 50KB. */
  readonly maxFileBytes?: number;
  /** Token estimator (chars/4-style). Injected for tests. */
  readonly estimateTokens?: (text: string) => number;
}

export interface ExpandReferencesResult {
  readonly text: string;
  readonly notices: readonly string[];
}

export interface ExpandInteractiveReferencesOptions extends ExpandReferencesOptions {
  readonly providers: VirtualReferenceProviders;
  /** Per-virtual-result byte cap before head/tail truncation. Default 50KB. */
  readonly maxReferenceBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 50 * 1024;
const CONTEXT_BUDGET_FRACTION = 0.8;
const defaultEstimate = (text: string): number => Math.ceil(text.length / 4);

/** Matches `@path` tokens at a word boundary (start or after whitespace). */
const REFERENCE_PATTERN = /(^|\s)@([^\s@]+)/gu;
const TRAILING_REFERENCE_PUNCTUATION_CHARS = ",.:)";

/**
 * Strip sentence punctuation off a captured path tail in LINEAR time — the
 * regex form (`/[,.:)]+$/`) backtracks polynomially on long runs of `)`
 * (CodeQL js/polynomial-redos; composer input is attacker-adjacent via paste).
 */
function stripTrailingReferencePunctuation(path: string): string {
  let end = path.length;
  while (end > 0 && TRAILING_REFERENCE_PUNCTUATION_CHARS.includes(path.charAt(end - 1))) {
    end -= 1;
  }
  return path.slice(0, end);
}

interface Reference {
  readonly raw: string; // the "@path" token
  readonly rel: string; // the path portion
  readonly index: number; // position of "@" in the source
}

function findReferences(text: string): readonly Reference[] {
  const refs: Reference[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const lead = match[1] ?? "";
    // Sentence punctuation is not part of the path. Leave it outside `raw` so
    // reverse splicing naturally preserves it after the expanded block.
    const rel = stripTrailingReferencePunctuation(match[2] ?? "");
    if (rel.length === 0) {
      continue;
    }
    const at = (match.index ?? 0) + lead.length;
    refs.push({ raw: `@${rel}`, rel, index: at });
  }
  return refs;
}

interface ResolvedRef extends Reference {
  readonly block: string; // the fenced replacement block (scrubbed)
  readonly tokens: number;
  readonly notice?: string;
}

function resolveOne(ref: Reference, options: ExpandReferencesOptions, estimate: (t: string) => number): ResolvedRef | { skip: string } {
  const root = resolve(options.repoRoot);
  const target = resolve(root, ref.rel);
  const relPath = relative(root, target);
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    return { skip: `${ref.raw} skipped: outside the repository root` };
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(target);
  } catch {
    return { skip: `${ref.raw} skipped: not found` };
  }
  if (!stats.isFile()) {
    return { skip: `${ref.raw} skipped: not a file` };
  }
  // Containment must survive symlinks — an in-repo link pointing outside the
  // root must not be inlined. Re-check the REAL path against the real root.
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    const realRel = relative(realRoot, realTarget);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      return { skip: `${ref.raw} skipped: resolves outside the repository root` };
    }
  } catch {
    return { skip: `${ref.raw} skipped: unresolved path` };
  }
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  let raw: Buffer;
  try {
    raw = readFileSync(target);
  } catch {
    return { skip: `${ref.raw} skipped: unreadable` };
  }
  if (raw.subarray(0, 4096).includes(0)) {
    return { skip: `${ref.raw} skipped: binary file` };
  }
  let contents: string;
  let truncationNotice: string | undefined;
  if (raw.length > maxBytes) {
    // Slice on BYTES (not decoded chars) so the reported byte count and the
    // kept head/tail stay accurate for non-ASCII files; decode after cutting.
    const head = Math.floor(maxBytes * 0.66);
    const tail = maxBytes - head;
    const headText = raw.subarray(0, head).toString("utf8");
    const tailText = raw.subarray(raw.length - tail).toString("utf8");
    contents = `${headText}\n… [${ref.raw}: ${raw.length - maxBytes} bytes truncated] …\n${tailText}`;
    truncationNotice = `${ref.raw} truncated to ~${Math.round(maxBytes / 1024)}KB (head+tail)`;
  } else {
    contents = raw.toString("utf8");
  }
  const relPosix = relPath.split(sep).join("/");
  const block = scrubSecretValues(`\n\n\`\`\`\`\`${relPosix}\n${contents}\n\`\`\`\`\`\n`);
  const result: ResolvedRef = { ...ref, block, tokens: estimate(block), ...(truncationNotice ? { notice: truncationNotice } : {}) };
  return result;
}

export function expandReferences(text: string, options: ExpandReferencesOptions): ExpandReferencesResult {
  const refs = findReferences(text);
  if (refs.length === 0) {
    return { text, notices: [] };
  }
  const estimate = options.estimateTokens ?? defaultEstimate;
  const budget = Math.max(0, Math.floor(options.contextWindowTokens * CONTEXT_BUDGET_FRACTION) - options.baseTokens);
  const notices: string[] = [];

  // Resolve all, then admit under budget in document order (deterministic).
  let spent = 0;
  const replacements = new Map<number, string>(); // index → block
  for (const ref of refs) {
    // Interactive Guru resolves these through typed providers first. The
    // file-only/headless path leaves them literal and must not add a duplicate
    // "not found" notice.
    if (isVirtualReference(ref.rel)) {
      continue;
    }
    const resolved = resolveOne(ref, options, estimate);
    if ("skip" in resolved) {
      notices.push(resolved.skip);
      continue;
    }
    if (spent + resolved.tokens > budget) {
      notices.push(`${ref.raw} skipped: expansion would exceed ~80% of the context window — reference specific lines instead`);
      continue;
    }
    spent += resolved.tokens;
    replacements.set(resolved.index, resolved.block);
    if (resolved.notice) {
      notices.push(resolved.notice);
    }
  }

  if (replacements.size === 0) {
    return { text, notices };
  }

  // Splice replacements in reverse index order so earlier indices stay valid.
  let out = text;
  const ordered = [...refs].filter((ref) => replacements.has(ref.index)).sort((a, b) => b.index - a.index);
  for (const ref of ordered) {
    const block = replacements.get(ref.index) as string;
    out = `${out.slice(0, ref.index)}${block}${out.slice(ref.index + ref.raw.length)}`;
  }
  return { text: out, notices };
}

/**
 * Interactive-only resolver: virtual and file references share one ordered
 * admission loop and therefore one aggregate 80%-of-context budget. The
 * existing synchronous file-only API remains unchanged for headless callers.
 */
export async function expandInteractiveReferences(
  text: string,
  options: ExpandInteractiveReferencesOptions
): Promise<ExpandReferencesResult> {
  const refs = findReferences(text);
  if (refs.length === 0) return { text, notices: [] };

  const estimate = options.estimateTokens ?? defaultEstimate;
  const budget = Math.max(0, Math.floor(options.contextWindowTokens * CONTEXT_BUDGET_FRACTION) - options.baseTokens);
  const notices: string[] = [];
  const replacements = new Map<number, string>();
  let spent = 0;

  for (const ref of refs) {
    const resolved = isVirtualReference(ref.rel)
      ? await resolveVirtualReference(ref, {
          repoRoot: options.repoRoot,
          providers: options.providers,
          estimateTokens: estimate,
          ...(options.maxReferenceBytes !== undefined ? { maxReferenceBytes: options.maxReferenceBytes } : {})
        })
      : resolveOne(ref, options, estimate);
    if ("skip" in resolved) {
      notices.push(resolved.skip);
      continue;
    }
    if (spent + resolved.tokens > budget) {
      notices.push(`${ref.raw} skipped: expansion would exceed ~80% of the context window — reference specific lines instead`);
      continue;
    }
    spent += resolved.tokens;
    replacements.set(ref.index, resolved.block);
    if (resolved.notice) notices.push(resolved.notice);
  }

  if (replacements.size === 0) return { text, notices };
  let out = text;
  const ordered = [...refs].filter((ref) => replacements.has(ref.index)).sort((left, right) => right.index - left.index);
  for (const ref of ordered) {
    out = `${out.slice(0, ref.index)}${replacements.get(ref.index) as string}${out.slice(ref.index + ref.raw.length)}`;
  }
  return { text: out, notices };
}
