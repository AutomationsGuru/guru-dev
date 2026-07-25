/** Optional worker-specific model selection layered over the parent model. */
export type WorkerModelDef = {
  readonly modelId?: string;
};

/** A swarm worker definition may select a model different from its parent. */
export interface WorkerDef extends WorkerModelDef {}

/**
 * Prefer the worker's non-empty model override; otherwise inherit the parent
 * model unchanged. Route authorization and budget enforcement remain owned by
 * the caller that creates the worker turn.
 */
export function resolveWorkerModel(parentModel: string, definition: WorkerModelDef): string {
  const override = definition.modelId?.trim();
  return override ? override : parentModel;
}
