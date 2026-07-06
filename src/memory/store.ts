import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectPotentialSecrets } from "../safety/policyGuard.js";
import { containsSecretValue } from "../safety/secretSafety.js";
import { extractLinks, parseFactFile, serializeFactFile } from "./frontmatter.js";
import {
  MEMORY_BODY_HARD_CAP,
  MEMORY_BODY_SOFT_CAP,
  MemoryRememberInputSchema,
  slugifyFactName,
  type MemoryDoctorReport,
  type MemoryFact,
  type MemoryForgetInput,
  type MemoryGetResult,
  type MemoryRememberInput,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemoryWriteResult
} from "./schemas.js";

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

export interface MemoryFactEntry {
  readonly fact: MemoryFact;
  readonly body: string;
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

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2)
  );
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) {
      hits += 1;
    }
  }
  return hits / Math.min(left.size, right.size);
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

  // Two-layer gate: policyGuard's named-kind patterns + the FR-21 shape list
  // (secretSafety) covering generic API keys / bearers / JWTs / private keys.
  const scrubGate = (input: MemoryRememberInput): string[] => {
    const fields = [
      { name: "title", value: input.title },
      { name: "description", value: input.description },
      { name: "body", value: input.body }
    ];
    const blockers = detectPotentialSecrets(fields).map(
      (match) => `memory write blocked: potential secret (${match.kind}) detected in ${match.name} — memory files must never hold secret values`
    );
    for (const field of fields) {
      if (containsSecretValue(field.value)) {
        blockers.push(`memory write blocked: token-shaped value detected in ${field.name} — memory files must never hold secret values`);
      }
    }
    return blockers;
  };

  const store: FileMemoryStore = {
    directory,

    remember(rawInput) {
      const input = MemoryRememberInputSchema.parse(rawInput);
      ensureDirs();

      const blockers = scrubGate(input);
      if (blockers.length > 0) {
        return { status: "blocked", summary: "Write blocked by the secret-safety gate.", blockers };
      }
      if (input.body.length > MEMORY_BODY_HARD_CAP) {
        return {
          status: "blocked",
          summary: "Write blocked: body exceeds the 32KB hard cap.",
          blockers: [`body is ${input.body.length} bytes (> ${MEMORY_BODY_HARD_CAP}); split this fact into linked smaller facts`]
        };
      }

      const timestamp = now().toISOString();
      const name = input.name ?? slugifyFactName(input.title);
      const path = factPath(name);
      const existing = existsSync(path) ? parseFactFile(readFileSync(path, "utf8")) : undefined;

      if (existing) {
        const body = input.edit === "append" ? `${existing.body}\n\n${input.body}` : input.body;
        if (body.length > MEMORY_BODY_HARD_CAP) {
          return {
            status: "blocked",
            summary: "Update blocked: appended body exceeds the 32KB hard cap.",
            blockers: [`resulting body would be ${body.length} bytes (> ${MEMORY_BODY_HARD_CAP}); split this fact`]
          };
        }
        const fact: MemoryFact = {
          ...existing.fact,
          title: input.title,
          description: input.description,
          type: input.type,
          confidence: input.confidence,
          updatedAt: timestamp
        };
        writeAtomic(path, serializeFactFile(fact, body));
        rebuildIndex();
        return { status: "updated", name, summary: `Updated [[${name}]] in place (${input.edit}).`, blockers: [] };
      }

      // Dedupe-before-save: only when the caller did NOT pass an explicit name
      // (an explicit name is the "yes, create it" confirmation).
      if (!input.name) {
        const inputTokens = tokenize(`${input.title} ${input.description}`);
        for (const entry of readEntries()) {
          const normalizedEqual = entry.fact.title.trim().toLowerCase() === input.title.trim().toLowerCase();
          const similar = overlapRatio(inputTokens, tokenize(`${entry.fact.title} ${entry.fact.description}`)) > 0.6;
          if (normalizedEqual || similar) {
            return {
              status: "blocked",
              summary: `Similar to existing fact [[${entry.fact.name}]] — update it instead, or pass an explicit name to confirm a new fact.`,
              blockers: [`similar-to:${entry.fact.name}`]
            };
          }
        }
      }

      const fact: MemoryFact = {
        name,
        title: input.title,
        description: input.description,
        type: input.type,
        createdAt: timestamp,
        updatedAt: timestamp,
        confidence: input.confidence,
        ...(options.sessionId ? { originSessionId: options.sessionId } : {})
      };
      writeAtomic(path, serializeFactFile(fact, input.body));
      rebuildIndex();
      const softCapNote = input.body.length > MEMORY_BODY_SOFT_CAP ? " (over the 16KB soft cap — consider splitting)" : "";
      return { status: "created", name, summary: `Remembered [[${name}]]${softCapNote}.`, blockers: [] };
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
      const links = extractLinks(parsed.body);
      const siblings = readEntries();
      const siblingNames = new Set(siblings.map((entry) => entry.fact.name));
      const backlinks = siblings.filter((entry) => entry.fact.name !== name && extractLinks(entry.body).includes(name)).map((entry) => entry.fact.name);
      const dangling = links.filter((link) => !siblingNames.has(link));
      const ageDays = Math.max(0, Math.floor((now().getTime() - Date.parse(parsed.fact.updatedAt)) / 86_400_000));
      const stalenessBanner = `This memory is ${ageDays} day${ageDays === 1 ? "" : "s"} old. Memories are point-in-time observations, not live state — verify against current code/state before asserting as fact.`;
      return {
        found: true,
        fact: parsed.fact,
        body: parsed.body,
        stalenessBanner,
        links: [...links],
        backlinks,
        danglingLinks: dangling,
        summary: `[[${name}]] (${parsed.fact.type}, updated ${parsed.fact.updatedAt}).`
      };
    },

    search(input) {
      const queryTokens = tokenize(input.terms);
      const hits = readEntries()
        .filter((entry) => (input.type ? entry.fact.type === input.type : true))
        .map((entry) => {
          const haystack = tokenize(`${entry.fact.name} ${entry.fact.title} ${entry.fact.description}`);
          let score = 0;
          for (const token of queryTokens) {
            if (haystack.has(token)) {
              score += 1;
            }
          }
          return { entry, score: queryTokens.size > 0 ? score / queryTokens.size : 0 };
        })
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, input.limit)
        .map(({ entry, score }) => ({
          name: entry.fact.name,
          title: entry.fact.title,
          description: entry.fact.description,
          type: entry.fact.type,
          updatedAt: entry.fact.updatedAt,
          score: Number(score.toFixed(3))
        }));
      return {
        hits,
        summary: hits.length > 0 ? `${hits.length} memory fact(s) matched — read with memory_get.` : "No memory facts matched."
      };
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
      writeFileSync(trashPath, trashed, "utf8");
      rmSync(path);
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
