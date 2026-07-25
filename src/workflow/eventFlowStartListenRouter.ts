import { z } from "zod";

// ── Node types ──────────────────────────────────────────────────────────────

export const FlowNodeKindSchema = z.enum(["start", "listen", "router"]);
export type FlowNodeKind = z.infer<typeof FlowNodeKindSchema>;

export const FlowNodeSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: FlowNodeKindSchema,
    listenFrom: z.string().trim().min(1).optional(),
    routerBranches: z.array(z.string().trim().min(1)).optional()
  })
  .strict();
export type FlowNode = z.infer<typeof FlowNodeSchema>;

// ── Error types ─────────────────────────────────────────────────────────────

export interface FlowValidationError {
  readonly nodeId: string;
  readonly kind: FlowNodeKind;
  readonly message: string;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a graph of start, listen(from), and router(branches) nodes.
 *
 * Rules:
 *  - At least one start node must exist.
 *  - Every listen node must declare `listenFrom` that references an existing
 *    node id.
 *  - Every router node must declare `routerBranches` with at least one branch
 *    target.
 *  - `listenFrom` / `routerBranches` must reference nodes that exist in the
 *    graph (orphan/reference checks).
 */
export function validateFlow(nodes: readonly FlowNode[]): {
  readonly valid: boolean;
  readonly errors: readonly FlowValidationError[];
} {
  const errors: FlowValidationError[] = [];
  const ids = new Set(nodes.map((n) => n.id));

  // Rule: at least one start
  const starts = nodes.filter((n) => n.kind === "start");
  if (starts.length === 0) {
    errors.push({
      nodeId: "(graph)",
      kind: "start",
      message: "A flow must contain at least one start node."
    });
  }

  for (const node of nodes) {
    switch (node.kind) {
      case "listen": {
        // Rule: listen must declare listenFrom
        if (!node.listenFrom || node.listenFrom.trim().length === 0) {
          errors.push({
            nodeId: node.id,
            kind: "listen",
            message: `Listen node "${node.id}" must declare a listenFrom target.`
          });
        } else if (!ids.has(node.listenFrom)) {
          // Rule: listenFrom must reference an existing node
          errors.push({
            nodeId: node.id,
            kind: "listen",
            message: `Listen node "${node.id}" listenFrom target "${node.listenFrom}" does not exist in the graph.`
          });
        }
        break;
      }
      case "router": {
        // Rule: router must declare routerBranches with at least one branch
        if (!node.routerBranches || node.routerBranches.length === 0) {
          errors.push({
            nodeId: node.id,
            kind: "router",
            message: `Router node "${node.id}" must declare at least one router branch.`
          });
        } else {
          // Rule: router branches must reference existing nodes
          for (const branch of node.routerBranches) {
            if (!ids.has(branch)) {
              errors.push({
                nodeId: node.id,
                kind: "router",
                message: `Router node "${node.id}" branch target "${branch}" does not exist in the graph.`
              });
            }
          }
        }
        break;
      }
      case "start":
        // No additional validation for start nodes
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}