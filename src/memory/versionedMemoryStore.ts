import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseFactFile, serializeFactFile } from "./frontmatter.js";
import { MemoryFactSchema, type MemoryFact } from "./schemas.js";

/**
 * Versioned memory store (IDEA-F177-MEM-GIT-01, P1 · effort M).
 *
 * Exports the agent's memory blocks to a directory layout under a memory root
 * and imports them back, so a memory snapshot can be tracked in git without the
 * harness ever invoking git. Every operation is a pure filesystem op routed
 * through an injectable fs seam, so the tests prove round-trip and path-safety
 * with no real git and no subprocess — the directory itself is the contract.
 *
 * On-disk format reuses `serializeFactFile` / `parseFactFile`, so an exported
 * snapshot is byte-identical to a live `FileMemoryStore` directory and round-
 * trips losslessly. A derived `MEMORY.md` index (the same shape the live store
 * rebuilds) is emitted alongside so a human reading the diff sees the table of
 * contents and a reviewer can paste a Conventional Commits message from
 * `suggestCommitMessage`.
 *
 * Hard edges honored in code, not prose:
 *  - No destruction without preservation: export only writes/overwrites files
 *    inside the root; import never deletes. Re-exporting overwrites in place.
 *  - Path safety under root: every written path is structurally contained
 *    inside `root` (defense-in-depth on top of the kebab-slug fact-name schema).
 *  - No leaked secrets: the secret gate already runs in `FileMemoryStore` before
 *    a block reaches this layer; this module only re-serializes already-stored
 *    facts and adds no new exfiltration surface.
 */

/** Narrow filesystem seam. Default is node:fs; tests inject a shim. */
export interface VersionedMemoryFs {
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
}

const realFs: VersionedMemoryFs = {
  mkdirSync: (path, options) => mkdirSync(path, options ?? {}),
  writeFileSync: (path, data, encoding) => writeFileSync(path, data, encoding),
  existsSync,
  readdirSync,
  readFileSync
};

const INDEX_FILE = "MEMORY.md";

/**
 * A memory block: the live fact plus its markdown body. Exactly the shape that
 * lives one-per-file in a `FileMemoryStore` directory.
 */
export interface VersionedMemoryBlock extends MemoryFact {
  readonly body: string;
}

export interface ExportOptions {
  /** Inject to route all FS ops through a shim (tests). Defaults to node:fs. */
  readonly fs?: VersionedMemoryFs;
}

export interface ExportReport {
  /** Absolute root the snapshot was written under. */
  readonly root: string;
  /** Number of block files written. */
  readonly blockCount: number;
  /** Absolute path to the derived MEMORY.md index. */
  readonly indexPath: string;
  /** Absolute paths of every file written (blocks + index). */
  readonly writtenPaths: readonly string[];
  readonly summary: string;
}

export interface ImportOptions {
  readonly fs?: VersionedMemoryFs;
}

export interface ImportReport {
  readonly blocks: readonly VersionedMemoryBlock[];
  /** Filenames skipped as corrupt (malformed frontmatter or name/file mismatch). */
  readonly skipped: readonly string[];
  readonly summary: string;
}

/**
 * Returns true when `child` resolves to a path inside `parent`. Uses `relative`
 * so it is robust across trailing-separator and `..` tricks; a result that is
 * empty (same path) or starts with `..`, or is an absolute path on another
 * drive, is rejected. This is the structural path-safety guard — the fact-name
 * schema already constrains names to kebab slugs, so this is defense-in-depth.
 */
function isContained(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") {
    return false; // child === parent: not a file inside the root.
  }
  return !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Export memory blocks to a directory layout under `root`. Each block becomes
 * `<root>/<name>.md` (the live store's format), plus a derived `MEMORY.md`
 * index. Idempotent: re-exporting overwrites in place. Never deletes.
 */
export function exportToDir(
  blocks: readonly VersionedMemoryBlock[],
  root: string,
  options: ExportOptions = {}
): ExportReport {
  const fs = options.fs ?? realFs;
  const rootAbs = resolve(root);

  if (!fs.existsSync(rootAbs)) {
    fs.mkdirSync(rootAbs, { recursive: true });
  }

  const written: string[] = [];

  for (const block of blocks) {
    // Re-validate the fact through the schema so an export can never materialize
    // a file the live store would have rejected (kebab slug, typed fields).
    const fact = MemoryFactSchema.parse(stripBody(block));
    const path = join(rootAbs, `${fact.name}.md`);

    // Structural containment guard — defense-in-depth on the name schema.
    if (!isContained(rootAbs, path)) {
      throw new Error(
        `versionedMemoryStore.exportToDir: resolved block path escapes root (name='${fact.name}')`
      );
    }

    fs.writeFileSync(path, serializeFactFile(fact, block.body), "utf8");
    written.push(path);
  }

  const indexPath = join(rootAbs, INDEX_FILE);
  if (!isContained(rootAbs, indexPath)) {
    throw new Error("versionedMemoryStore.exportToDir: index path escapes root");
  }
  fs.writeFileSync(indexPath, buildIndexContent(blocks), "utf8");
  written.push(indexPath);

  const blockCount = blocks.length;
  return {
    root: rootAbs,
    blockCount,
    indexPath,
    writtenPaths: written,
    summary: `Exported ${blockCount} memory block(s) to ${rootAbs} (index: ${INDEX_FILE}).`
  };
}

function stripBody(block: VersionedMemoryBlock): Omit<VersionedMemoryBlock, "body"> {
  const { body: _body, ...rest } = block;
  void _body;
  return rest;
}

function buildIndexContent(blocks: readonly VersionedMemoryBlock[]): string {
  const lines = [
    "# Guru Memory Index",
    "",
    "<!-- DERIVED FILE — rebuilt from fact frontmatter; do not hand-edit lines. -->",
    "",
    ...blocks.map((b) => `- [${b.title}](${b.name}.md) — ${b.description}`),
    ""
  ];
  return lines.join("\n");
}

/**
 * Import memory blocks from a directory layout previously written by
 * `exportToDir` (or by the live `FileMemoryStore`). Reads every `*.md` except
 * the derived index, re-parses via `parseFactFile`, and skips corrupt files
 * rather than throwing — one bad file never takes down the import.
 */
export function importFromDir(root: string, options: ImportOptions = {}): ImportReport {
  const fs = options.fs ?? realFs;
  const rootAbs = resolve(root);

  if (!fs.existsSync(rootAbs)) {
    return { blocks: [], skipped: [], summary: `Memory root '${rootAbs}' does not exist.` };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(rootAbs);
  } catch {
    return { blocks: [], skipped: [], summary: `Memory root '${rootAbs}' is not readable.` };
  }

  const blocks: VersionedMemoryBlock[] = [];
  const skipped: string[] = [];

  for (const file of entries) {
    if (!file.endsWith(".md") || file === INDEX_FILE || file.endsWith(".md.tmp")) {
      continue;
    }
    const path = join(rootAbs, file);
    let parsed: ReturnType<typeof parseFactFile>;
    try {
      parsed = parseFactFile(fs.readFileSync(path, "utf8"));
    } catch {
      skipped.push(file);
      continue;
    }
    // parseFactFile already enforces name/file consistency (it returns undefined
    // when the frontmatter name does not match), so a defined result is trusted.
    if (parsed) {
      blocks.push({ ...parsed.fact, body: parsed.body });
    } else {
      skipped.push(file);
    }
  }

  blocks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const summaryParts = [`${blocks.length} block(s) imported`];
  if (skipped.length > 0) {
    summaryParts.push(`${skipped.length} corrupt file(s) skipped`);
  }
  return { blocks, skipped, summary: `${summaryParts.join(", ")} from ${rootAbs}.` };
}

export interface MemoryChangeSummary {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  /** Commit scope; defaults to "memory" when omitted. */
  readonly scope?: string;
}

/**
 * Produce a suggested Conventional Commits message from a change summary. Pure
 * — no I/O. Used so a human (or a later review gate) can paste the snapshot's
 * commit message without the harness running git itself.
 */
export function suggestCommitMessage(change: MemoryChangeSummary): string {
  const scope = change.scope && change.scope.length > 0 ? change.scope : "memory";
  const lines: string[] = [];

  if (change.added.length === 0 && change.updated.length === 0 && change.removed.length === 0) {
    return `${scope}: no memory changes`;
  }

  lines.push(`${scope}: version memory snapshot`);

  const bullets: string[] = [];
  if (change.added.length > 0) {
    bullets.push(`Add ${change.added.join(", ")}`);
  }
  if (change.updated.length > 0) {
    bullets.push(`Update ${change.updated.join(", ")}`);
  }
  if (change.removed.length > 0) {
    bullets.push(`Remove ${change.removed.join(", ")}`);
  }

  return `${lines.join("\n")}\n\n${bullets.map((b) => `- ${b}`).join("\n")}\n`;
}
