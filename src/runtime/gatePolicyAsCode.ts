import {
  GateDefinitionSchema,
  GatePolicySchema,
  type GateDefinition,
  type GatePolicyDocument,
  type GatePolicyInput
} from "./gatePolicyAsCodeSchema.js";

export { GatePolicySchema } from "./gatePolicyAsCodeSchema.js";
export type { GateDefinition, GatePolicyDocument, GatePolicyInput } from "./gatePolicyAsCodeSchema.js";

export class GatePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatePolicyError";
  }
}

export interface ParsedGatePolicy extends Omit<GatePolicyDocument, "gates"> {
  readonly gates: readonly GateDefinition[];
  readonly gatesFor: (taskType: string) => readonly GateDefinition[];
}

/** Parse a JSON gate policy object or document, rejecting malformed definitions. */
export function parsePolicy(input: unknown): ParsedGatePolicy {
  const document = parseDocument(input);
  const gates = normalizeGates(document.gates);
  const policy: ParsedGatePolicy = {
    version: document.version,
    gates,
    taskTypes: document.taskTypes,
    gatesFor: (taskType) => gatesForParsedPolicy(policy, taskType)
  };

  return policy;
}

/** Return the gates required by a task type; unknown task types and gate ids fail closed. */
export function gatesFor(policy: ParsedGatePolicy, taskType: string): readonly GateDefinition[] {
  return gatesForParsedPolicy(policy, taskType);
}

/** Export a serializable ordered list of gate definitions for completion-gate consumers. */
export function exportGateList(policy: ParsedGatePolicy, taskType: string): readonly GateDefinition[] {
  return gatesFor(policy, taskType).map((gate) => ({
    id: gate.id,
    kind: gate.kind,
    params: { ...gate.params }
  })) as readonly GateDefinition[];
}

function parseDocument(input: unknown): GatePolicyDocument {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input) as unknown;
    } catch (error) {
      throw new GatePolicyError(`Invalid gate policy document: ${formatError(error)}`);
    }
  }

  const parsed = GatePolicySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
      .join("; ");
    throw new GatePolicyError(`Invalid gate policy document: ${details}`);
  }

  return parsed.data;
}

function normalizeGates(gates: GatePolicyDocument["gates"]): readonly GateDefinition[] {
  if (Array.isArray(gates)) {
    const normalized = gates.map((gate) => GateDefinitionSchema.parse(gate));
    assertUniqueGateIds(normalized);
    return normalized;
  }

  return Object.entries(gates).map(([id, gate]) =>
    GateDefinitionSchema.parse({ id, ...gate })
  );
}

function gatesForParsedPolicy(policy: ParsedGatePolicy, taskType: string): readonly GateDefinition[] {
  const gateIds = policy.taskTypes[taskType];
  if (!gateIds) {
    throw new GatePolicyError(`Unknown task type "${taskType}" in gate policy.`);
  }

  const byId = new Map(policy.gates.map((gate) => [gate.id, gate]));
  return gateIds.map((id) => {
    const gate = byId.get(id);
    if (!gate) {
      throw new GatePolicyError(`Unknown gate id "${id}" for task type "${taskType}".`);
    }
    return gate;
  });
}

function assertUniqueGateIds(gates: readonly GateDefinition[]): void {
  const seen = new Set<string>();
  for (const gate of gates) {
    if (seen.has(gate.id)) {
      throw new GatePolicyError(`Duplicate gate id "${gate.id}" in gate policy.`);
    }
    seen.add(gate.id);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

