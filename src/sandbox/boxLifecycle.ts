import { z } from "zod";

// ── Status ───────────────────────────────────────────────────────────────────

export const BoxStatusSchema = z.enum([
  "created",
  "running",
  "stopped",
  "destroyed",
]);
export type BoxStatus = z.infer<typeof BoxStatusSchema>;

// ── Record ───────────────────────────────────────────────────────────────────

export const BoxRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    status: BoxStatusSchema,
  })
  .strict();
export type BoxRecord = z.infer<typeof BoxRecordSchema>;

// ── Registry ─────────────────────────────────────────────────────────────────

/** In-memory box registry — a plain Map keyed by box id. */
export type BoxRegistry = Map<string, BoxRecord>;

export function createRegistry(): BoxRegistry {
  return new Map();
}

// ── Error ────────────────────────────────────────────────────────────────────

export class BoxLifecycleError extends Error {
  public readonly boxId: string;
  public readonly from: BoxStatus | undefined;
  public readonly attempted: string;

  constructor(
    boxId: string,
    from: BoxStatus | undefined,
    attempted: string,
    reason: string,
  ) {
    super(`Box "${boxId}": cannot ${attempted} from "${from ?? "absent"}" — ${reason}`);
    this.name = "BoxLifecycleError";
    this.boxId = boxId;
    this.from = from;
    this.attempted = attempted;
  }
}

// ── Transition table ─────────────────────────────────────────────────────────

/**
 * Legal target status for each source status.  `destroyed` has no outgoing
 * transitions — it is terminal.
 */
const LEGAL_TRANSITIONS: Record<BoxStatus, readonly BoxStatus[]> = {
  created: ["running", "destroyed"],
  running: ["stopped", "destroyed"],
  stopped: ["running", "destroyed"],
  destroyed: [],
};

// ── Pure APIs ────────────────────────────────────────────────────────────────

/** Create a new box in `created` status.  Rejects if the id already exists. */
export function createBox(registry: BoxRegistry, id: string): BoxRecord {
  if (registry.has(id)) {
    throw new BoxLifecycleError(id, undefined, "create", "id already exists");
  }
  const record: BoxRecord = { id, status: "created" };
  registry.set(id, record);
  return record;
}

/** Transition an existing box to `running`. */
export function startBox(registry: BoxRegistry, id: string): BoxRecord {
  return transition(registry, id, "running", "start");
}

/** Transition an existing box to `stopped`. */
export function stopBox(registry: BoxRegistry, id: string): BoxRecord {
  return transition(registry, id, "stopped", "stop");
}

/** Transition an existing box to `destroyed` (terminal). */
export function destroyBox(registry: BoxRegistry, id: string): BoxRecord {
  return transition(registry, id, "destroyed", "destroy");
}

// ── Lookup ───────────────────────────────────────────────────────────────────

export function getBox(
  registry: BoxRegistry,
  id: string,
): BoxRecord | undefined {
  return registry.get(id);
}

export function listBoxes(registry: BoxRegistry): BoxRecord[] {
  return [...registry.values()];
}

// ── Internal ─────────────────────────────────────────────────────────────────

function transition(
  registry: BoxRegistry,
  id: string,
  target: BoxStatus,
  verb: string,
): BoxRecord {
  const current = registry.get(id);
  if (!current) {
    throw new BoxLifecycleError(id, undefined, verb, "box not found");
  }
  const allowed = LEGAL_TRANSITIONS[current.status];
  if (!allowed.includes(target)) {
    throw new BoxLifecycleError(
      id,
      current.status,
      verb,
      `illegal transition from "${current.status}" to "${target}"`,
    );
  }
  const next: BoxRecord = { id, status: target };
  registry.set(id, next);
  return next;
}
