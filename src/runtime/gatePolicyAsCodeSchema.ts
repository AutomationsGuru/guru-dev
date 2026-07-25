import { z } from "zod";

export const GateIdSchema = z.string().trim().min(1);
export const TaskTypeSchema = z.string().trim().min(1);

const FilesExistGateSchema = z
  .object({
    id: GateIdSchema,
    kind: z.literal("files-exist"),
    params: z
      .object({ paths: z.array(z.string().trim().min(1)).min(1) })
      .strict()
  })
  .strict();

const CommandExitZeroGateSchema = z
  .object({
    id: GateIdSchema,
    kind: z.literal("command-exit-zero"),
    params: z
      .object({ command: z.string().trim().min(1) })
      .strict()
  })
  .strict();

const OperatorApprovedGateSchema = z
  .object({
    id: GateIdSchema,
    kind: z.literal("operator-approved"),
    params: z.object({}).strict()
  })
  .strict();

export const GateDefinitionSchema = z.discriminatedUnion("kind", [
  FilesExistGateSchema,
  CommandExitZeroGateSchema,
  OperatorApprovedGateSchema
]);
export type GateDefinition = z.infer<typeof GateDefinitionSchema>;

const GateDefinitionWithoutIdSchema = z.discriminatedUnion("kind", [
  FilesExistGateSchema.omit({ id: true }),
  CommandExitZeroGateSchema.omit({ id: true }),
  OperatorApprovedGateSchema.omit({ id: true })
]);

export const GateDefinitionsSchema = z.union([
  z.array(GateDefinitionSchema),
  z.record(GateIdSchema, GateDefinitionWithoutIdSchema)
]);

export const GatePolicySchema = z
  .object({
    version: z.literal(1).default(1),
    gates: GateDefinitionsSchema,
    taskTypes: z.record(TaskTypeSchema, z.array(GateIdSchema).min(1))
  })
  .strict();

export type GatePolicyInput = z.input<typeof GatePolicySchema>;
export type GatePolicyDocument = z.infer<typeof GatePolicySchema>;
