import { z } from "zod";

const WORKFLOW_ID = z.string().trim().min(1).max(80);

export const WorkflowAgentSchema = z
  .object({
    id: WORKFLOW_ID
  })
  .strict();

export const WorkflowRouteSchema = z.union([
  z
    .object({
      from: WORKFLOW_ID,
      to: WORKFLOW_ID,
      when: z.string().trim().min(1).max(2_000)
    })
    .strict(),
  z
    .object({
      from: WORKFLOW_ID,
      to: WORKFLOW_ID,
      fallback: z.literal(true)
    })
    .strict()
]);

export const WorkflowOutputSchema = z
  .object({
    id: WORKFLOW_ID,
    from: WORKFLOW_ID
  })
  .strict();

export const WorkflowDocumentSchema = z
  .object({
    agents: z.array(WorkflowAgentSchema).min(1).max(64),
    entry: WORKFLOW_ID,
    routes: z.array(WorkflowRouteSchema).max(256),
    outputs: z.array(WorkflowOutputSchema).max(64)
  })
  .strict()
  .superRefine((document, context) => {
    const agentIds = new Set<string>();
    for (const [index, agent] of document.agents.entries()) {
      if (agentIds.has(agent.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate agent id: ${agent.id}`,
          path: ["agents", index, "id"]
        });
      }
      agentIds.add(agent.id);
    }

    if (!agentIds.has(document.entry)) {
      context.addIssue({
        code: "custom",
        message: `Unknown entry agent: ${document.entry}`,
        path: ["entry"]
      });
    }

    for (const [index, route] of document.routes.entries()) {
      if (!agentIds.has(route.from)) {
        context.addIssue({
          code: "custom",
          message: `Unknown route source agent: ${route.from}`,
          path: ["routes", index, "from"]
        });
      }
      if (!agentIds.has(route.to)) {
        context.addIssue({
          code: "custom",
          message: `Unknown route destination agent: ${route.to}`,
          path: ["routes", index, "to"]
        });
      }
      if ("fallback" in route && document.routes.slice(index + 1).some((next) => next.from === route.from)) {
        context.addIssue({
          code: "custom",
          message: `Fallback route from ${route.from} must be final for that agent`,
          path: ["routes", index, "fallback"]
        });
      }
    }

    const outputIds = new Set<string>();
    for (const [index, output] of document.outputs.entries()) {
      if (outputIds.has(output.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate output id: ${output.id}`,
          path: ["outputs", index, "id"]
        });
      }
      outputIds.add(output.id);
      if (!agentIds.has(output.from)) {
        context.addIssue({
          code: "custom",
          message: `Unknown output agent: ${output.from}`,
          path: ["outputs", index, "from"]
        });
      }
    }
  });

export type WorkflowDocument = z.infer<typeof WorkflowDocumentSchema>;

/** Validates caller-supplied JSON only; this function never reads or executes a workflow. */
export function parseWorkflowDocument(input: unknown) {
  return WorkflowDocumentSchema.safeParse(input);
}
