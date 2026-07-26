import { z } from 'zod';

/**
 * PeerCliConfig — configuration for optional ATTACH of external coding CLI (stdio/ACP).
 *
 * - enabled: default false (opt-in ATTACH, never silent dependency per VISION §1.5)
 * - command: binary or script to spawn (e.g. "goose", "cursor-agent")
 * - args: optional argv
 * - env: optional env var overrides (keys only; values treated as opaque)
 * - timeoutMs: spawn timeout (default 5min)
 */
export const PeerCliConfigSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().positive().optional(),
});

export type PeerCliConfig = z.infer<typeof PeerCliConfigSchema>;
