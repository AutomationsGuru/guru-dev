/**
 * Shared resource scope (Dev 4 — interface freeze).
 *
 * The five resource roots from FR-12 / build-plan D4.4: global, project, shared,
 * package, configured. Shared across prompts, packages, and themes so trust/scope
 * rules are uniform.
 */

import { z } from "zod";

export const ResourceScopeSchema = z.enum(["global", "project", "shared", "package", "configured"]);
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;
