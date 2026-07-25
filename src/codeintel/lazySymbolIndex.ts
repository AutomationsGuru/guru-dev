/**
 * Lazy in-memory symbol index (codeintel stub; no LSP, no filesystem).
 *
 * Identity key is `${path}\0${name}` so the same symbol name may exist at
 * multiple paths. Queries return frozen stored records in stable name/path order.
 */

/** Symbol kinds used by the lazy in-memory index (codeintel stub; no LSP). */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "method"
  | "enum"
  | "module"
  | "other";

export interface SymbolRecord {
  readonly path: string;
  readonly name: string;
  readonly kind: SymbolKind;
}

export interface LazySymbolIndex {
  /** Insert or replace a symbol keyed by (path, name). Returns the stored record. */
  upsert(symbol: SymbolRecord): SymbolRecord;
  /** Exact name match (case-sensitive). Empty array on miss. */
  queryByName(name: string): readonly SymbolRecord[];
  /** Case-sensitive name prefix match. Empty prefix returns all (stable order). Empty array on miss. */
  queryByPrefix(prefix: string): readonly SymbolRecord[];
  /** Number of distinct (path, name) entries. */
  size(): number;
  /** Remove all entries. */
  clear(): void;
}

const SYMBOL_KINDS: ReadonlySet<SymbolKind> = new Set([
  "function",
  "class",
  "interface",
  "type",
  "variable",
  "method",
  "enum",
  "module",
  "other"
]);

function isNonEmptyText(value: string): boolean {
  return value.trim().length > 0;
}

function isSymbolKind(value: string): value is SymbolKind {
  return SYMBOL_KINDS.has(value as SymbolKind);
}

function symbolKey(path: string, name: string): string {
  return `${path}\0${name}`;
}

function compareRecords(left: SymbolRecord, right: SymbolRecord): number {
  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
}

function validateSymbol(symbol: SymbolRecord): SymbolRecord {
  if (typeof symbol.path !== "string" || !isNonEmptyText(symbol.path)) {
    throw new Error("Symbol path must be a non-empty, non-whitespace string");
  }
  if (typeof symbol.name !== "string" || !isNonEmptyText(symbol.name)) {
    throw new Error("Symbol name must be a non-empty, non-whitespace string");
  }
  if (typeof symbol.kind !== "string" || !isSymbolKind(symbol.kind)) {
    throw new Error(
      `Symbol kind must be one of: ${[...SYMBOL_KINDS].join(", ")} (got ${JSON.stringify(symbol.kind)})`
    );
  }

  return Object.freeze({
    path: symbol.path,
    name: symbol.name,
    kind: symbol.kind
  });
}

function sortedValues(entries: Map<string, SymbolRecord>): readonly SymbolRecord[] {
  return [...entries.values()].sort(compareRecords);
}

export function createLazySymbolIndex(initial?: readonly SymbolRecord[]): LazySymbolIndex {
  const entries = new Map<string, SymbolRecord>();

  const index: LazySymbolIndex = {
    upsert(symbol) {
      const stored = validateSymbol(symbol);
      entries.set(symbolKey(stored.path, stored.name), stored);
      return stored;
    },
    queryByName(name) {
      if (typeof name !== "string" || name.length === 0) {
        return [];
      }
      return sortedValues(entries).filter((record) => record.name === name);
    },
    queryByPrefix(prefix) {
      if (typeof prefix !== "string") {
        return [];
      }
      if (prefix.length === 0) {
        return sortedValues(entries);
      }
      return sortedValues(entries).filter((record) => record.name.startsWith(prefix));
    },
    size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    }
  };

  if (initial) {
    for (const symbol of initial) {
      index.upsert(symbol);
    }
  }

  return index;
}
