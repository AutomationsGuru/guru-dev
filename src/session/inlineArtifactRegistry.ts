import { z } from "zod";

/**
 * Inline artifact registry (IDEA-F474-IART-01).
 *
 * A pure-metadata index of artifacts produced by harness steps. It records the
 * artifact's `mime` and `path` (plus an optional label) keyed by a stable id,
 * grouped by the step that produced it, so callers can later enumerate what an
 * arbitrary step emitted without re-deriving it.
 *
 * Hard contract — this is a **registry**, not a store:
 *
 * - It NEVER creates, reads, moves, or deletes real artifacts on disk. The
 *   `path` here is opaque metadata supplied by the caller; this module performs
 *   no filesystem I/O and treats the value as an untrusted string.
 * - It owns an in-memory map only. Lifetime is the registry's lifetime; nothing
 *   is persisted, so there is nothing to destroy and no hard-limit surface here.
 *
 * Overwrite semantics: `put` with an id already present replaces the prior
 * record in place and keeps a single monotonic `sequence` (insertion order is
 * preserved by reusing the original slot). This is the contract exercised by the
 * "duplicate id overwrite" test.
 */

const trimmedMin = (min: number) =>
  z
    .string()
    .trim()
    .min(min);

export const InlineArtifactRecordSchema = z
  .object({
    /** Stable, caller-chosen id. Collisions overwrite the prior record. */
    id: trimmedMin(1),
    /** Owning step. `listByStep` filters on this. */
    stepId: trimmedMin(1),
    /** MIME type of the artifact (e.g. "image/png", "text/markdown"). Opaque here. */
    mime: trimmedMin(1),
    /** Logical path/location of the artifact. Opaque string — never resolved to disk. */
    path: trimmedMin(1),
    /** Optional human-readable label. */
    label: trimmedMin(1).optional(),
    /** Monotonic insertion sequence assigned by the registry; drives list order. */
    sequence: z.number().int().nonnegative()
  })
  .strict();
export type InlineArtifactRecord = z.infer<typeof InlineArtifactRecordSchema>;

/** Input accepted by {@link InlineArtifactRegistry.put}; `sequence` is registry-assigned. */
export const InlineArtifactInputSchema = InlineArtifactRecordSchema.omit({ sequence: true });
export type InlineArtifactInput = z.infer<typeof InlineArtifactInputSchema>;

export interface InlineArtifactRegistry {
  /** Returns the number of distinct artifact ids currently registered. */
  readonly size: number;

  /**
   * Register (or replace) an artifact by id. On a duplicate id the prior record
   * is overwritten in place — its original insertion slot is retained so list
   * order is stable, but the stored payload becomes the new input. Returns the
   * canonical stored record (with its assigned `sequence`).
   */
  put(input: InlineArtifactInput): InlineArtifactRecord;

  /** Look up a record by id, or `undefined` if absent. */
  get(id: string): InlineArtifactRecord | undefined;

  /** Whether an artifact id is currently registered. */
  has(id: string): boolean;

  /** All records in insertion (`sequence`) order. */
  list(): readonly InlineArtifactRecord[];

  /** Records belonging to `stepId`, in insertion (`sequence`) order. */
  listByStep(stepId: string): readonly InlineArtifactRecord[];

  /** Remove every record. Test affordance; no disk effect. */
  clear(): void;
}

/**
 * In-memory {@link InlineArtifactRegistry}. `createInlineArtifactRegistry` is the
 * canonical constructor; tests may also instantiate directly.
 */
export class InMemoryInlineArtifactRegistry implements InlineArtifactRegistry {
  private readonly byId = new Map<string, InlineArtifactRecord>();
  /** Insertion order; an overwritten id keeps its original index. */
  private readonly order: string[] = [];
  private nextSequence = 0;

  get size(): number {
    return this.byId.size;
  }

  put(input: InlineArtifactInput): InlineArtifactRecord {
    const parsed = InlineArtifactInputSchema.parse(input);
    const existing = this.byId.get(parsed.id);
    // Overwrite preserves the original insertion sequence so list order is
    // stable across replacements (the duplicate-id-overwrite contract).
    const sequence = existing ? existing.sequence : this.nextSequence++;
    const record: InlineArtifactRecord = { ...parsed, sequence };
    if (!existing) this.order.push(parsed.id);
    this.byId.set(parsed.id, record);
    return record;
  }

  get(id: string): InlineArtifactRecord | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): readonly InlineArtifactRecord[] {
    return this.order.map((id) => this.byId.get(id)).filter((r): r is InlineArtifactRecord => r !== undefined);
  }

  listByStep(stepId: string): readonly InlineArtifactRecord[] {
    return this.list().filter((r) => r.stepId === stepId);
  }

  clear(): void {
    this.byId.clear();
    this.order.length = 0;
    this.nextSequence = 0;
  }
}

/** Construct an empty in-memory inline artifact registry. */
export function createInlineArtifactRegistry(): InlineArtifactRegistry {
  return new InMemoryInlineArtifactRegistry();
}
