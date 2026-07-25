import type { z, ZodType } from "zod";

import { BatchSkillInputSchema, createBatchSkillPlan } from "./builtin/batchSkill.js";
import { createLoopSkillPlan, LoopSkillInputSchema } from "./builtin/loopSkill.js";
import { createReviewSkillPlan, ReviewSkillInputSchema } from "./builtin/reviewSkill.js";

export interface BuiltinSkillPlan {
  readonly objective: string;
  readonly steps: readonly string[];
}

export interface BuiltinSkillInvocation<TPlan extends BuiltinSkillPlan = BuiltinSkillPlan> {
  readonly kind: "prompt-plan";
  readonly skillId: string;
  readonly slashCommand: `/${string}`;
  readonly disableModelInvocation: boolean;
  readonly prompt: string;
  readonly plan: TPlan;
  readonly execution: {
    readonly autoExecute: false;
    readonly gitActions: readonly never[];
  };
}

export interface BuiltinSkillDefinition<TInputSchema extends ZodType = ZodType> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly slashCommand: `/${string}`;
  /** Built-ins are operator-invoked by default, never selected by the model implicitly. */
  readonly disableModelInvocation: boolean;
  readonly inputSchema: TInputSchema;
  createInvocation(input: z.infer<TInputSchema>): BuiltinSkillInvocation;
}

const builtinDefinitions = [
  defineBuiltin({
    id: "review",
    name: "Review",
    description: "Create a verified code-review prompt and plan without modifying the repository.",
    slashCommand: "/review",
    inputSchema: ReviewSkillInputSchema,
    createPlan: createReviewSkillPlan
  }),
  defineBuiltin({
    id: "loop",
    name: "Loop",
    description: "Create a bounded iterative-work prompt and plan with an explicit stop condition.",
    slashCommand: "/loop",
    inputSchema: LoopSkillInputSchema,
    createPlan: createLoopSkillPlan
  }),
  defineBuiltin({
    id: "batch",
    name: "Batch",
    description: "Create a dependency-aware batch prompt and plan without starting workers.",
    slashCommand: "/batch",
    inputSchema: BatchSkillInputSchema,
    createPlan: createBatchSkillPlan
  })
] as const;

const builtins = new Map<string, BuiltinSkillDefinition>(builtinDefinitions.map((definition) => [definition.id, definition] as const));

/** Register the shipped built-ins once. Repeated calls are intentionally idempotent. */
export function registerBuiltinSkills(): readonly BuiltinSkillDefinition[] {
  for (const definition of builtinDefinitions) {
    builtins.set(definition.id, definition);
  }

  return listBuiltins();
}

/** List registered built-ins in stable id order. */
export function listBuiltins(): readonly BuiltinSkillDefinition[] {
  return [...builtins.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Validate an input and return a prompt/plan artifact; this never starts execution. */
export function invokeBuiltinSkill(skillId: string, input: unknown): BuiltinSkillInvocation {
  registerBuiltinSkills();
  const normalizedSkillId = skillId.startsWith("/") ? skillId.slice(1) : skillId;
  const definition = builtins.get(normalizedSkillId);

  if (!definition) {
    throw new Error(`Built-in skill not found: ${skillId}`);
  }

  return definition.createInvocation(definition.inputSchema.parse(input));
}

function defineBuiltin<TInputSchema extends ZodType, TPlan extends BuiltinSkillPlan>(options: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly slashCommand: `/${string}`;
  readonly inputSchema: TInputSchema;
  createPlan(input: z.infer<TInputSchema>): { readonly prompt: string; readonly plan: TPlan };
}): BuiltinSkillDefinition<TInputSchema> {
  return {
    id: options.id,
    name: options.name,
    description: options.description,
    slashCommand: options.slashCommand,
    disableModelInvocation: true,
    inputSchema: options.inputSchema,
    createInvocation(input) {
      const artifact = options.createPlan(input);

      return {
        kind: "prompt-plan",
        skillId: options.id,
        slashCommand: options.slashCommand,
        disableModelInvocation: true,
        prompt: artifact.prompt,
        plan: artifact.plan,
        execution: {
          autoExecute: false,
          gitActions: []
        }
      };
    }
  };
}
