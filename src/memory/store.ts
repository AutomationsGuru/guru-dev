import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { extractLinks, parseFactFile, serializeFactFile } from "./frontmatter.js";
import {
  buildMemoryGetResult,
  planPreflightedMemoryRemember,
  preflightMemoryRemember,
  searchMemoryEntries,
  type MemoryFactEntry
} from "./policy.js";
import {
  type MemoryDoctorReport,
  type MemoryForgetInput,
  type MemoryGetResult,
  type MemoryRememberInput,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemoryWriteResult
} from "./schemas.js";

export type { MemoryFactEntry } from "./policy.js";

/**
 * FileMemoryStore — Guru's L1 memory organ (Foundation Wave PR 2, 2026-07-04).
 *
 * One fact per markdown file under a memory directory (default global scope:
 * ~/.guruharness/memory/), plus a DERIVED MEMORY.md index (rebuilt from fact
 * frontmatter — drift self-heals) and a .trash/ soft-delete dir. The directory
 * is a valid Obsidian vault by construction (markdown + YAML properties +
 * [[wiki-links]] + .trash/).
 *
 * Guarantees: atomic writes (tmp+rename), dedupe-before-save, secret-scrub gate
 * on every write (detectPotentialSecrets — blockers carry KINDS, never values),
 * safeParse-skip-corrupt reads, size caps, 30-day trash GC.
 */

const DEFAULT_SUBDIR = join(".guruharness", "memory");
const INDEX_FILE = "MEMORY.md";
const TRASH_DIR = ".trash";
const TRASH_GC_DAYS = 30;
export const MEMORY_INDEX_LINE_CAP = 50;

export interface FileMemoryStoreOptions {
  /** Directory override (tests / space / role scopes). Defaults to ~/.guruharness/memory. */
  readonly directory?: string;
  readonly now?: () => Date;
  readonly sessionId?: string;
}

export interface FileMemoryStore {
  readonly directory: string;
  remember(input: MemoryRememberInput): MemoryWriteResult;
  get(name: string): MemoryGetResult;
  search(input: MemorySearchInput): MemorySearchResult;
  forget(input: MemoryForgetInput): MemoryWriteResult;
  list(): readonly MemoryFactEntry[];
  rebuildIndex(): string;
  buildIndexLines(cap?: number): readonly string[];
  doctor(): MemoryDoctorReport;
}

export function resolveMemoryDirectory(options: FileMemoryStoreOptions = {}): string {
  return options.directory ?? join(homedir(), DEFAULT_SUBDIR);
}

export function createFileMemoryStore(options: FileMemoryStoreOptions = {}): FileMemoryStore {
  const directory = resolveMemoryDirectory(options);
  const now = options.now ?? (() => new Date());

  const ensureDirs = (): void => {
    for (const dir of [directory, join(directory, TRASH_DIR)]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  };

  const factPath = (name: string): string => join(directory, `${name}.md`);

  const writeAtomic = (path: string, content: string): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  };

  const readEntries = (report?: string[]): MemoryFactEntry[] => {
    if (!existsSync(directory)) {
      return [];
    }
    const entries: MemoryFactEntry[] = [];
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".md") || file === INDEX_FILE || file.endsWith(".md.tmp")) {
        continue;
      }
      try {
        const parsed = parseFactFile(readFileSync(join(directory, file), "utf8"));
        if (parsed && `${parsed.fact.name}.md` === file) {
          entries.push(parsed);
        } else {
          report?.push(file);
        }
      } catch {
        report?.push(file);
      }
    }
    return entries.sort((left, right) => right.fact.updatedAt.localeCompare(left.fact.updatedAt));
  };

  const buildIndexContent = (entries: readonly MemoryFactEntry[]): string => {
    const lines = [
      "# Guru Memory Index",
      "",
      "<!-- DERIVED FILE — rebuilt from fact frontmatter at boot/doctor; do not hand-edit lines. -->",
      "",
      ...entries.map(({ fact }) => `- [${fact.title}](${fact.name}.md) — ${fact.description}`)
    ];
    return `${lines.join("\n")}\n`;
  };

  const rebuildIndex = (): string => {
    ensureDirs();
    const content = buildIndexContent(readEntries());
    writeAtomic(join(directory, INDEX_FILE), content);
    return content;
  };

  const store: FileMemoryStore = {
    directory,

    remember(rawInput) {
      const preflight = preflightMemoryRemember(rawInput);
      if (preflight.kind === "blocked") {
        return preflight.result;
      }
      ensureDirs();
      const timestamp = now().toISOString();
      const plan = planPreflightedMemoryRemember(preflight, readEntries(), {
        timestamp,
        ...(options.sessionId ? { sessionId: options.sessionId } : {})
      });
      if (plan.kind === "blocked") {
        return plan.result;
      }
      writeAtomic(factPath(plan.name), serializeFactFile(plan.fact, plan.body));
      rebuildIndex();
      return plan.result;
    },

    get(name) {
      const path = factPath(name);
      if (!existsSync(path)) {
        return { found: false, links: [], backlinks: [], danglingLinks: [], summary: `No memory fact named '${name}'.` };
      }
      const parsed = parseFactFile(readFileSync(path, "utf8"));
      if (!parsed) {
        return { found: false, links: [], backlinks: [], danglingLinks: [], summary: `Fact file '${name}.md' is malformed — run /memory doctor.` };
      }
      const siblings = readEntries();
      return buildMemoryGetResult(name, siblings, now());
    },

    search(input) {
      return searchMemoryEntries(input, readEntries());
    },

    forget(input) {
      const path = factPath(input.name);
      if (!existsSync(path)) {
        return { status: "blocked", summary: `No memory fact named '${input.name}'.`, blockers: ["not-found"] };
      }
      ensureDirs();
      const original = readFileSync(path, "utf8");
      const trashed = `${original.trimEnd()}\n\n<!-- forgotten ${now().toISOString()}: ${input.reason} -->\n`;
      const trashPath = join(directory, TRASH_DIR, `${input.name}.${now().getTime()}.md`);
      // Atomic trash write first (Windows EBUSY-safe vs write-then-delete race):
      // never delete the live fact until the trash copy is durable (B20).
      writeAtomic(trashPath, trashed);
      try {
        rmSync(path);
      } catch {
        // Trash is durable; leave the live file if delete fails (e.g. Windows
        // EBUSY) and rebuild the index so the operator can retry — never lose
        // the only copy mid-move.
        rebuildIndex();
        return {
          status: "forgotten",
          name: input.name,
          summary: `Copied [[${input.name}]] to .trash/ (live file still present after delete failed — safe to retry /forget).`,
          blockers: ["delete-deferred"]
        };
      }
      rebuildIndex();
      return { status: "forgotten", name: input.name, summary: `Moved [[${input.name}]] to .trash/ (30-day GC). Reason recorded.`, blockers: [] };
    },

    list() {
      return readEntries();
    },

    rebuildIndex,

    buildIndexLines(cap = MEMORY_INDEX_LINE_CAP) {
      const entries = readEntries();
      const lines = entries.slice(0, cap).map(({ fact }) => `- [${fact.title}](${fact.name}.md) — ${fact.description}`);
      if (entries.length > cap) {
        lines.push(`- ...and ${entries.length - cap} more (memory_search to find them)`);
      }
      return lines;
    },

    doctor() {
      ensureDirs();
      const corrupt: string[] = [];
      const entries = readEntries(corrupt);

      let orphanTemps = 0;
      for (const file of readdirSync(directory)) {
        if (file.endsWith(".tmp")) {
          rmSync(join(directory, file));
          orphanTemps += 1;
        }
      }

      let trashRemoved = 0;
      const trashDir = join(directory, TRASH_DIR);
      const cutoff = now().getTime() - TRASH_GC_DAYS * 86_400_000;
      for (const file of readdirSync(trashDir)) {
        try {
          if (statSync(join(trashDir, file)).mtimeMs < cutoff) {
            rmSync(join(trashDir, file));
            trashRemoved += 1;
          }
        } catch {
          // unreadable trash entries are left in place
        }
      }

      const names = new Set(entries.map((entry) => entry.fact.name));
      const dangling: string[] = [];
      for (const entry of entries) {
        for (const link of extractLinks(entry.body)) {
          if (!names.has(link)) {
            dangling.push(`${entry.fact.name} -> [[${link}]]`);
          }
        }
      }

      rebuildIndex();
      return {
        directory,
        factCount: entries.length,
        corruptSkipped: corrupt,
        orphanTempsRemoved: orphanTemps,
        trashRemoved,
        danglingLinks: dangling,
        indexRebuilt: true,
        summary: `${entries.length} fact(s); ${corrupt.length} corrupt skipped; ${orphanTemps} orphan temp(s) swept; ${trashRemoved} trash file(s) GC'd; ${dangling.length} dangling link(s). Index rebuilt.`
      };
    }
  };

  return store;
}
