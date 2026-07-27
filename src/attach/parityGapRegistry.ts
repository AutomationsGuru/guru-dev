import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  ParityGapEntrySchema,
  ParityGapRegisterInputSchema,
  ParityGapStatusSchema,
  type ParityGapEntry,
  type ParityGapId,
  type ParityGapListResult,
  type ParityGapRegisterInput,
  type ParityGapStatus
} from "./parityGapSchema.js";

/**
 * Parity-gap registry: durable, scoped, honest record of every ATTACH move.
 *
 * ATTACH is explicitly provisional. Every borrowed capability gets an id, a
 * surface, a non-empty gap description, a promotion trigger, and an
 * operator-visible status. Entries are persisted inside the project harness
 * scope (`.guru/state`) so they travel with the project and never silently
 * mutate the operator's reusable home profile. Before persistence each entry
 * is run through a structural secret scrubber so no key, token, or connection
 * string can leak into the registry file.
 */

export interface ParityGapRegistry {
  /** Register a new gap; returns the scrubbed, persisted entry. */
  register(input: ParityGapRegisterInput): ParityGapEntry;
  /** List all registered gaps, ordered by creation time. */
  list(): ParityGapListResult;
  /** Get a single gap by id, or undefined if absent. */
  get(id: ParityGapId): ParityGapEntry | undefined;
  /** Update the operator-visible status of a gap; returns the entry or undefined. */
  setStatus(id: ParityGapId, status: ParityGapStatus): ParityGapEntry | undefined;
}

export interface CreateParityGapRegistryOptions {
  /** Project-scoped state directory (e.g. `<project>/.guru/state`). */
  readonly stateDirectory: string;
  /** Optional stable clock override for tests. */
  readonly now?: () => Date;
}

const REGISTRY_FILE_NAME = "parity-gaps.json";

const SECRET_PREFIX_RE =
  /\b(api[_-]?key|apikey|auth[_-]?token|bearer|password|secret|token|private[_-]?key|credential|connection[_-]?string)\s*[:=]\s*[^\s]{4,}/gi;

const HIGH_ENTROPY_RE = /\b[A-Za-z0-9+/]{32,}={0,2}|\b[0-9a-f]{32,}\b|\b[0-9A-F]{32,}\b/g;

const REDACTED_PLACEHOLDER = "[REDACTED]";
const SCRUBBED_PLACEHOLDER = "[SCRUBBED]";

export function createParityGapRegistry(options: CreateParityGapRegistryOptions): ParityGapRegistry {
  const stateDirectory = options.stateDirectory;
  const registryPath = join(stateDirectory, REGISTRY_FILE_NAME);
  const now = options.now ?? (() => new Date());

  let entries = loadEntries(registryPath);

  function persist(): void {
    mkdirSync(dirname(registryPath), { recursive: true });
    writeJsonAtomic(registryPath, { entries });
  }

  return {
    register(input: ParityGapRegisterInput): ParityGapEntry {
      const parsed = ParityGapRegisterInputSchema.parse(input);
      const existing = entries.find((entry) => entry.id === parsed.id);
      if (existing) {
        throw new Error(`Parity gap '${parsed.id}' is already registered.`);
      }

      const timestamp = now().toISOString();
      const entry = ParityGapEntrySchema.parse({
        id: parsed.id,
        surface: parsed.surface,
        gapDescription: parsed.gapDescription,
        promotionTrigger: parsed.promotionTrigger,
        status: parsed.status,
        createdAt: timestamp,
        updatedAt: timestamp,
        secretScrubbed: true
      });

      const scrubbed = scrubEntry(entry);
      entries = [...entries, scrubbed].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      persist();
      return scrubbed;
    },

    list(): ParityGapListResult {
      return { entries: [...entries], count: entries.length };
    },

    get(id: ParityGapId): ParityGapEntry | undefined {
      return entries.find((entry) => entry.id === id);
    },

    setStatus(id: ParityGapId, status: ParityGapStatus): ParityGapEntry | undefined {
      ParityGapStatusSchema.parse(status);
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return undefined;
      }
      const updated = { ...entries[index], status, updatedAt: now().toISOString(), secretScrubbed: true };
      const scrubbed = scrubEntry(updated);
      entries = [...entries.slice(0, index), scrubbed, ...entries.slice(index + 1)];
      persist();
      return scrubbed;
    }
  };
}

function loadEntries(registryPath: string): readonly ParityGapEntry[] {
  try {
    const text = readFileSync(registryPath, "utf8");
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    if (typeof raw !== "object" || raw === null || !("entries" in raw)) {
      return [];
    }
    const parsed = z.array(ParityGapEntrySchema).safeParse((raw as { entries: unknown }).entries);
    return parsed.success ? parsed.data : [];
  } catch (error) {
    return isNotFoundError(error) ? [] : [];
  }
}

function scrubEntry(entry: ParityGapEntry): ParityGapEntry {
  return {
    ...entry,
    surface: scrubString(entry.surface),
    gapDescription: scrubString(entry.gapDescription),
    promotionTrigger: scrubString(entry.promotionTrigger),
    secretScrubbed: true
  };
}

function scrubString(value: string): string {
  let scrubbed = value;
  scrubbed = scrubbed.replace(SECRET_PREFIX_RE, (_match, prefix: string) => `${prefix}=${REDACTED_PLACEHOLDER}`);
  scrubbed = scrubbed.replace(HIGH_ENTROPY_RE, SCRUBBED_PLACEHOLDER);
  return scrubbed;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
