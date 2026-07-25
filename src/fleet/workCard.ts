import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  CreateWorkCardInputSchema,
  ListWorkCardsFilterSchema,
  WorkCardSchema,
  type CreateWorkCardInput,
  type ListWorkCardsFilter,
  type WorkCard,
  type WorkCardStatus
} from "./workCardSchema.js";

/**
 * Fleet work card store (F63 / R-CL-KANBAN MVP).
 *
 * Persistence layout (project overlay, not home profile):
 *   <projectRoot>/.guru/cards/<id>.json
 *
 * Isolation path allocation (MVP):
 *   <projectRoot>/.guru/worktrees/<id>/
 * This is a plain directory for parallel-work isolation. It does NOT invoke
 * `git worktree add` — git topology mutation is intentionally out of scope.
 * A future ATTACH may wrap real git worktrees behind this same field.
 *
 * Guarantees: atomic writes (tmp+rename), safeParse-skip-corrupt on read,
 * cycle rejection on create when dependsOn would form a cycle, injected
 * clock/id/roots so tests stay deterministic.
 */

export const WORK_CARD_DIRECTORY_NAME = "cards";
export const WORK_CARD_WORKTREE_DIRECTORY_NAME = "worktrees";
export const PROJECT_GURU_DIRECTORY_NAME = ".guru";

/** Structured error when dependsOn would introduce a cycle. */
export class WorkCardDependencyCycleError extends Error {
  readonly code = "work_card_dependency_cycle";
  constructor(
    readonly cardId: string,
    readonly dependsOn: readonly string[]
  ) {
    super(
      `Work card "${cardId}" dependsOn would introduce a dependency cycle: [${dependsOn.join(", ")}]`
    );
    this.name = "WorkCardDependencyCycleError";
  }
}

export interface WorkCardStoreOptions {
  /** Project root that owns `.guru/cards`. Required. */
  readonly projectRoot: string;
  /**
   * Override the cards directory. Defaults to
   * `<projectRoot>/.guru/cards`. Tests inject a temp path.
   */
  readonly cardsDirectory?: string;
  /**
   * Root under which isolation dirs are allocated. Defaults to
   * `<projectRoot>/.guru/worktrees`.
   */
  readonly worktreeRoot?: string;
  /** Injected clock (ISO via toISOString). Defaults to wall clock. */
  readonly now?: () => Date;
  /** Injected id factory. Defaults to a short UUID slice (swarm style). */
  readonly generateId?: () => string;
}

export interface WorkCardStore {
  readonly cardsDirectory: string;
  readonly worktreeRoot: string;
  /** Create a card; allocates isolation dir by default; rejects dependency cycles. */
  createCard(input: CreateWorkCardInput): WorkCard;
  /** Load one card by id, or undefined if missing/corrupt. */
  getCard(id: string): WorkCard | undefined;
  /** List cards, optionally filtered by status. Corrupt files are skipped. */
  listCards(filter?: ListWorkCardsFilter): readonly WorkCard[];
}

/**
 * Resolve the default cards directory under a project root.
 * Pure path helper — does not create directories.
 */
export function resolveWorkCardDirectory(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_GURU_DIRECTORY_NAME, WORK_CARD_DIRECTORY_NAME);
}

/**
 * Resolve the default isolation (worktree) root under a project root.
 * Pure path helper — does not create directories.
 */
export function resolveWorkCardWorktreeRoot(projectRoot: string): string {
  return join(
    resolve(projectRoot),
    PROJECT_GURU_DIRECTORY_NAME,
    WORK_CARD_WORKTREE_DIRECTORY_NAME
  );
}

/**
 * Build the isolation path for a card id under a worktree root.
 * Pure path helper — does not create directories.
 */
export function allocateWorktreePath(worktreeRoot: string, cardId: string): string {
  return join(resolve(worktreeRoot), cardId);
}

/**
 * Detect whether adding `newId` with `newDependsOn` would create a cycle
 * against the existing graph (id → dependsOn).
 *
 * - Self-dependency is a cycle.
 * - Missing dependency targets are allowed (not a cycle by themselves).
 * - `newId`'s edges are treated as `newDependsOn` (replacing any prior).
 */
export function wouldCreateDependencyCycle(
  existing: ReadonlyMap<string, readonly string[]>,
  newId: string,
  newDependsOn: readonly string[]
): boolean {
  if (newDependsOn.includes(newId)) {
    return true;
  }

  // Walk from each direct dep looking for a path back to newId.
  const graph = new Map(existing);
  graph.set(newId, newDependsOn);

  for (const start of newDependsOn) {
    if (canReach(graph, start, newId)) {
      return true;
    }
  }
  return false;
}

function canReach(
  graph: ReadonlyMap<string, readonly string[]>,
  from: string,
  target: string
): boolean {
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === target) {
      return true;
    }
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    const edges = graph.get(node);
    if (edges) {
      for (const next of edges) {
        stack.push(next);
      }
    }
  }
  return false;
}

export function createWorkCardStore(options: WorkCardStoreOptions): WorkCardStore {
  const projectRoot = resolve(options.projectRoot);
  const cardsDirectory = options.cardsDirectory
    ? resolve(options.cardsDirectory)
    : resolveWorkCardDirectory(projectRoot);
  const worktreeRoot = options.worktreeRoot
    ? resolve(options.worktreeRoot)
    : resolveWorkCardWorktreeRoot(projectRoot);
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? (() => randomUUID().slice(0, 8));

  const ensureCardsDir = (): void => {
    if (!existsSync(cardsDirectory)) {
      mkdirSync(cardsDirectory, { recursive: true });
    }
  };

  const cardPath = (id: string): string => join(cardsDirectory, `${id}.json`);

  const writeAtomic = (path: string, content: string): void => {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  };

  const readAll = (): WorkCard[] => {
    if (!existsSync(cardsDirectory)) {
      return [];
    }
    const cards: WorkCard[] = [];
    for (const file of readdirSync(cardsDirectory)) {
      if (!file.endsWith(".json") || file.endsWith(".json.tmp")) {
        continue;
      }
      try {
        const parsed = WorkCardSchema.safeParse(
          JSON.parse(readFileSync(join(cardsDirectory, file), "utf8"))
        );
        if (parsed.success && `${parsed.data.id}.json` === file) {
          cards.push(parsed.data);
        }
      } catch {
        // safeParse-skip-corrupt: ignore unreadable/invalid files
      }
    }
    return cards;
  };

  const dependencyGraph = (cards: readonly WorkCard[]): Map<string, readonly string[]> => {
    const graph = new Map<string, readonly string[]>();
    for (const card of cards) {
      graph.set(card.id, card.dependsOn);
    }
    return graph;
  };

  const ensureIsolationDir = (path: string): void => {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  };

  return {
    cardsDirectory,
    worktreeRoot,

    createCard(rawInput) {
      const input = CreateWorkCardInputSchema.parse(rawInput);
      const id = generateId();
      const dependsOn = input.dependsOn ?? [];
      const existing = readAll();
      const graph = dependencyGraph(existing);

      if (wouldCreateDependencyCycle(graph, id, dependsOn)) {
        throw new WorkCardDependencyCycleError(id, dependsOn);
      }

      // Prefer an explicit worktreePath; otherwise allocate when not disabled.
      const allocate = input.allocateWorktree !== false;
      let worktreePath: string | undefined = input.worktreePath;
      if (!worktreePath && allocate) {
        worktreePath = allocateWorktreePath(worktreeRoot, id);
      }
      if (worktreePath) {
        ensureIsolationDir(worktreePath);
      }

      const stamp = now().toISOString();
      const card: WorkCard = WorkCardSchema.parse({
        id,
        title: input.title,
        status: (input.status ?? "backlog") as WorkCardStatus,
        ...(worktreePath ? { worktreePath } : {}),
        dependsOn,
        createdAt: stamp,
        updatedAt: stamp
      });

      ensureCardsDir();
      writeAtomic(cardPath(id), `${JSON.stringify(card, null, 2)}\n`);
      return card;
    },

    getCard(id) {
      const path = cardPath(id);
      if (!existsSync(path)) {
        return undefined;
      }
      try {
        const parsed = WorkCardSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },

    listCards(rawFilter) {
      const filter = ListWorkCardsFilterSchema.parse(rawFilter ?? {});
      const cards = readAll();
      const filtered = filter.status
        ? cards.filter((card) => card.status === filter.status)
        : cards;
      // Stable order: createdAt then id.
      return filtered
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }
  };
}
