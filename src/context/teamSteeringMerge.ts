/**
 * Team steering merge — combines steering layers in priority order
 * team (lowest) → global → workspace (highest). On key conflicts the
 * higher-priority layer's entry WINS by value, but the winning entry
 * REPLACES in-place at the FIRST-seen position across the sweep — it
 * does NOT move to the winning layer's position. Pure, deterministic,
 * side-effect free: inputs are never mutated.
 */

/** The three steering scopes, in ascending priority order. */
export type SteeringScope = "team" | "global" | "workspace";

/** A single keyed steering entry. Empty content strings are valid winners. */
export interface SteeringEntry {
  readonly key: string;
  readonly content: string;
}

/** A named scope's steering layer: its scope plus its entries (in array order). */
export interface SteeringLayer {
  readonly scope: SteeringScope;
  readonly entries: readonly SteeringEntry[];
}

/**
 * Merge steering layers team → global → workspace, with workspace winning on
 * key conflicts.
 *
 * Rules:
 * - Priority (ascending): team (lowest) → global → workspace (highest).
 * - Same key across layers: the higher-priority layer's entry WINS by value.
 * - Stable order: each key occupies its FIRST-seen position across the
 *   team→global→workspace sweep; an override REPLACES the value in place
 *   and never moves the key to the winning layer's position.
 * - Duplicate keys WITHIN one layer collapse to the LAST occurrence for
 *   that key; the position is the first intra-layer occurrence.
 * - Duplicate scope occurrence (two "team" layers): only the FIRST layer
 *   of that scope is used; the rest are ignored silently, no error.
 * - Missing or empty-entries layers are skipped silently. `undefined`
 *   input is treated as `[]`.
 * - Pure: a fresh array is returned each call and inputs are never mutated.
 *
 * One pass suffices because priority order IS iteration order, so any
 * later-seen equal key is by construction from an equal-or-higher layer;
 * the map-set-on-second-sight collapses both intra-layer duplicates and
 * cross-layer overrides, while `order` only ever appends on first sight.
 */
export function mergeTeamSteering(layers: readonly SteeringLayer[] | undefined): SteeringEntry[] {
  const source = layers ?? [];

  // STEP 1 — pick the first layer of each scope (duplicate scopes ignored),
  // then build the canonical priority chain skipping missing/empty layers.
  const team = source.find((l) => l.scope === "team");
  const global = source.find((l) => l.scope === "global");
  const workspace = source.find((l) => l.scope === "workspace");

  const chain: readonly SteeringLayer[] = [team, global, workspace].filter(
    (l): l is SteeringLayer => l !== undefined && l.entries.length > 0
  );

  // STEP 2 — single pass over the chain (priority ascending).
  // `order` records first-seen key positions; `resolved` holds the winning
  // entry for each key so far. A later sight only overrides the VALUE;
  // first-seen position is untouched.
  const order: string[] = [];
  const resolved = new Map<string, SteeringEntry>();

  for (const layer of chain) {
    for (const entry of layer.entries) {
      if (resolved.has(entry.key)) {
        resolved.set(entry.key, entry);
      } else {
        order.push(entry.key);
        resolved.set(entry.key, entry);
      }
    }
  }

  // STEP 3 — materialize. Every key in `order` has a value in `resolved`
  // (entries are appended to `order` only at the same instant a value is
  // set in `resolved`, and values are never deleted), so the non-null
  // assertion here is invariant-safe.
  return order.map((k) => resolved.get(k)!);
}
