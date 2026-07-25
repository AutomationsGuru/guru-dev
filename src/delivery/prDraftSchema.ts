import { z } from "zod";

export const PrDraftSchema = z
  .object({
    title: z.string().trim().min(1),
    body: z.string(),
    files: z.array(z.string().trim().min(1)),
    testPlan: z.string()
  })
  .strict();
export type PrDraft = z.infer<typeof PrDraftSchema>;