import { z } from "zod";

import { discoverSkills, loadSkill } from "../../skills/loader.js";
import {
  LoadSkillInputSchema,
  SkillCatalogSchema,
  SkillDocumentSchema,
  SkillLoaderOptionsSchema,
  type SkillLoaderOptions
} from "../../skills/schemas.js";
import type { ToolDefinition } from "../registry.js";

export const ListSkillsToolInputSchema = z.object({}).strict();
export const ListSkillsToolOutputSchema = SkillCatalogSchema;
export const LoadSkillToolOutputSchema = SkillDocumentSchema;

export function createListSkillsTool(options: Partial<SkillLoaderOptions>): ToolDefinition<typeof ListSkillsToolInputSchema, typeof ListSkillsToolOutputSchema> {
  const loaderOptions = SkillLoaderOptionsSchema.parse(options);

  return {
    id: "skills.catalog.list",
    title: "List runtime skills",
    description: "Discover file-based GuruHarness skills from configured skill directories.",
    inputSchema: ListSkillsToolInputSchema,
    outputSchema: ListSkillsToolOutputSchema,
    execute(_input, _context) {
      return discoverSkills(loaderOptions);
    }
  };
}

export function createLoadSkillTool(options: Partial<SkillLoaderOptions>): ToolDefinition<typeof LoadSkillInputSchema, typeof LoadSkillToolOutputSchema> {
  const loaderOptions = SkillLoaderOptionsSchema.parse(options);

  return {
    id: "skill.document.load",
    title: "Load runtime skill",
    description: "Load a file-based GuruHarness skill document by skill id.",
    inputSchema: LoadSkillInputSchema,
    outputSchema: LoadSkillToolOutputSchema,
    execute(input, _context) {
      return loadSkill({ ...loaderOptions, skillId: input.skillId });
    }
  };
}
