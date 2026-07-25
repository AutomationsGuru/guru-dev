import { z } from 'zod';

export const AgentRgbPersonaCardSchema = z.object({
  role: z.string().min(1, 'Role must not be empty'),
  goal: z.string().min(1, 'Goal must not be empty'),
  backstory: z.string().min(1, 'Backstory must not be empty'),
});

export type AgentRgbPersonaCard = z.infer<typeof AgentRgbPersonaCardSchema>;
