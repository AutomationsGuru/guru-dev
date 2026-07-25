export interface RunContext {
  readonly state: Readonly<Record<string, unknown>>;
  readonly maxDepth: number;
  readonly allowedBindKeys?: ReadonlySet<string>;
}

export interface WorkflowTarget {
  readonly id: string;
  readonly requiredInputs?: ReadonlySet<string>;
}

export type Resolvable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Resolvable[]
  | { [key: string]: Resolvable }
  | { $ref: string };

export interface InvocationDescriptor {
  readonly kind: "invocation";
  readonly workflowId: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export type ComposeResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

function resolveMapping(
  mapping: Resolvable,
  ctx: RunContext,
  activeRefs: ReadonlySet<string>,
  depth: number
): ComposeResult<unknown> {
  if (depth > ctx.maxDepth) {
    return { success: false, error: `Mapping depth exceeded max depth of ${ctx.maxDepth}` };
  }

  if (mapping === null || typeof mapping !== "object") {
    return { success: true, data: mapping };
  }

  if (Array.isArray(mapping)) {
    const arr: unknown[] = [];
    for (let i = 0; i < mapping.length; i++) {
      const res = resolveMapping(mapping[i], ctx, activeRefs, depth + 1);
      if (!res.success) return res;
      arr.push(res.data);
    }
    return { success: true, data: arr };
  }

  if ("$ref" in mapping && typeof mapping.$ref === "string") {
    const ref = mapping.$ref;
    if (activeRefs.has(ref)) {
      return { success: false, error: `Cycle detected resolving reference: ${ref}` };
    }

    if (!(ref in ctx.state)) {
       return { success: false, error: `Reference not found in context: ${ref}` };
    }

    const newRefs = new Set(activeRefs);
    newRefs.add(ref);
    return resolveMapping(ctx.state[ref] as Resolvable, ctx, newRefs, depth + 1);
  }

  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mapping)) {
    const res = resolveMapping(v, ctx, activeRefs, depth + 1);
    if (!res.success) return res;
    obj[k] = res.data;
  }
  return { success: true, data: obj };
}

export function invokeSub(
  target: WorkflowTarget,
  mapping: Record<string, Resolvable>,
  ctx: RunContext
): ComposeResult<InvocationDescriptor> {
  const inputs: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(mapping)) {
    const res = resolveMapping(v, ctx, new Set(), 0);
    if (!res.success) {
      return { success: false, error: `Failed to map input '${k}': ${res.error}` };
    }
    inputs[k] = res.data;
  }

  if (target.requiredInputs) {
    for (const req of target.requiredInputs) {
      if (!(req in inputs)) {
        return { success: false, error: `Missing required input: ${req}` };
      }
    }
  }

  Object.freeze(inputs);

  return {
    success: true,
    data: {
      kind: "invocation",
      workflowId: target.id,
      inputs
    }
  };
}

export function bindSet(
  ctx: RunContext,
  pairs: Record<string, Resolvable>
): ComposeResult<RunContext> {
  if (ctx.allowedBindKeys) {
    for (const k of Object.keys(pairs)) {
      if (!ctx.allowedBindKeys.has(k)) {
        return { success: false, error: `Key '${k}' is not in allowed bind keys` };
      }
    }
  }

  const newBound: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pairs)) {
    const res = resolveMapping(v, ctx, new Set(), 0);
    if (!res.success) {
      return { success: false, error: `Failed to bind key '${k}': ${res.error}` };
    }
    newBound[k] = res.data;
  }

  const newState = { ...ctx.state, ...newBound };
  Object.freeze(newState);

  return {
    success: true,
    data: {
      ...ctx,
      state: newState
    }
  };
}
