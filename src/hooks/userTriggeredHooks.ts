import { z } from "zod";

/** The literal discriminator for user-triggered hooks. */
export const USER_TRIGGERED_WHEN = "userTriggered" as const;

export const UserTriggeredHookActionSchema = z
  .object({
    shell: z
      .object({
        command: z.string().trim().min(1),
        confirm: z.boolean().default(true)
      })
      .strict()
      .optional(),
    askAgent: z
      .object({
        prompt: z.string().trim().min(1)
      })
      .strict()
      .optional()
  })
  .strict()
  .refine(
    (data) => data.shell !== undefined || data.askAgent !== undefined,
    {
      message: "At least one of 'shell' or 'askAgent' must be defined in a user-triggered hook action"
    }
  );
export type UserTriggeredHookAction = z.infer<typeof UserTriggeredHookActionSchema>;

export const UserTriggeredHookSchema = z
  .object({
    id: z.string().trim().min(1),
    /** Slash-invocable name, e.g. "/lint-staged". Stripped leading "/" on match. */
    name: z.string().trim().min(1),
    when: z.literal(USER_TRIGGERED_WHEN),
    enabled: z.boolean().default(true),
    /** The action to return (NOT auto-execute) when this hook is invoked. */
    then: UserTriggeredHookActionSchema
  })
  .strict();
export type UserTriggeredHook = z.infer<typeof UserTriggeredHookSchema>;

export const UserTriggeredHooksConfigSchema = z
  .object({
    hooks: z.array(UserTriggeredHookSchema).default([])
  })
  .strict();
export type UserTriggeredHooksConfig = z.infer<typeof UserTriggeredHooksConfigSchema>;

/**
 * Normalize a name for lookup: strip leading "/" so both "/lint" and "lint" match
 * a hook registered as "/lint".
 */
function normalizeName(name: string): string {
  return name.replace(/^\//, "");
}

export class UserTriggeredHooksRegistry {
  private hooks: Map<string, UserTriggeredHook> = new Map();

  /**
   * Register a user-triggered hook. Duplicate names warn and keep the first
   * registration (same collision policy as the extension command registry).
   */
  public register(hook: UserTriggeredHook): void {
    const parsed = UserTriggeredHookSchema.parse(hook);
    const key = normalizeName(parsed.name);

    if (this.hooks.has(key)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[user-triggered-hooks] Hook already registered: ${parsed.name} — keeping the first, ignoring the duplicate.`
      );
      return;
    }

    this.hooks.set(key, parsed);
  }

  /**
   * Look up a user-triggered hook by name (with or without leading "/").
   * Throws for unknown names.
   * Returns the `then` action WITHOUT executing it — the caller decides
   * whether/when to run a shell command or submit an askAgent prompt.
   */
  public invoke(name: string): UserTriggeredHookAction {
    const key = normalizeName(name);
    const hook = this.hooks.get(key);

    if (!hook || !hook.enabled) {
      throw new Error(`Unknown user-triggered hook: "${name}"`);
    }

    return hook.then;
  }

  /** Return the current hook list (for config inspection / listing). */
  public list(): readonly UserTriggeredHook[] {
    return [...this.hooks.values()];
  }

  /** Remove all registered hooks. */
  public clear(): void {
    this.hooks.clear();
  }
}