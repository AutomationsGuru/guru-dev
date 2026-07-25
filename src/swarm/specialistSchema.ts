import { z } from "zod";

export const SpecialistConfigSchema = z
  .object({
    name: z.string().trim().min(1).regex(/^[a-z0-9-]+$/u, "Name must be kebab-case"),
    systemPrompt: z.string().trim().min(1),
    allowedTools: z.array(z.string().trim().min(1)).min(1)
  })
  .strict();

export type SpecialistConfig = z.infer<typeof SpecialistConfigSchema>;
