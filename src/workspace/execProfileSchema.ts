import { z } from "zod";

/** Profile kind: local host execution, or isolated backend (worktree/docker) via explicit ATTACH. */
export const ExecProfileKindSchema = z.enum(["local", "isolated"]);
export type ExecProfileKind = z.infer<typeof ExecProfileKindSchema>;

/** Reference to an isolated backend. Values are presence-only identifiers; secrets live in env, never here. */
export const ExecProfileBackendRefSchema = z
  .object({
    host: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1).optional(),
    containerId: z.string().trim().min(1).optional()
  })
  .strict();
export type ExecProfileBackendRef = z.infer<typeof ExecProfileBackendRefSchema>;

/**
 * Workspace execution profile: same agent tools resolve to the local host OR an
 * isolated backend without rewriting tool call sites. Default is local; isolated
 * requires an explicit ATTACH adapter and is blocked until one is supplied.
 */
export const ExecProfileSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: ExecProfileKindSchema.default("local"),
    rootPath: z.string().trim().min(1),
    backendRef: ExecProfileBackendRefSchema.optional()
  })
  .strict()
  .refine(
    (profile) => profile.kind !== "isolated" || profile.backendRef !== undefined,
    {
      message: "isolated profile requires an explicit backendRef (ATTACH only).",
      path: ["backendRef"]
    }
  );
export type ExecProfile = z.infer<typeof ExecProfileSchema>;
export type ExecProfileInput = z.input<typeof ExecProfileSchema>;
