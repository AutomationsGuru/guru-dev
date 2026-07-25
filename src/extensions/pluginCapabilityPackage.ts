import { z } from "zod";

const CapabilityIdSchema = z.string().trim().min(1);

/**
 * Declares the capabilities a plugin contributes without coupling the extension
 * host to a marketplace or a specific runtime implementation.
 */
export const PluginCapabilityPackageSchema = z
  .object({
    id: CapabilityIdSchema,
    agents: z.array(CapabilityIdSchema),
    skills: z.array(CapabilityIdSchema),
    commands: z.array(CapabilityIdSchema)
  })
  .strict();

export type PluginCapabilityPackage = z.infer<typeof PluginCapabilityPackageSchema>;

/** Parse an unknown plugin capability declaration into the typed package shape. */
export function parsePluginCapabilityPackage(input: unknown): PluginCapabilityPackage {
  return PluginCapabilityPackageSchema.parse(input);
}
