/**
 * Ranked repository map — public API for the rank layer.
 *
 * Composes with {@link repoMapGraph.ts} to score symbols by cross-file reference
 * graph relevance and emit a ranked map trimmed to a token budget.
 *
 * ## Entry points
 * - {@link rankRepoMap} — rank an already-built graph under a token budget.
 * - {@link buildRepoMapForRoot} — one-shot: build + rank from a file list.
 * - {@link renderRepoMap} / {@link renderRepoMapJson} — text / JSON output.
 */

export {
  buildRepoMapForRoot,
  rankRepoMap,
  renderRepoMap,
  renderRepoMapJson,
  scoreRepoMap,
} from "./repoMapGraph.js";

export type {
  RankedRepoMap,
  RankedRepoMapEntry,
  RankedRepoMapOptions,
  ScoredNode,
  ScoreRepoMapOptions,
} from "./repoMapGraph.js";
