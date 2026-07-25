import { z } from "zod";

import { McpServerIdSchema } from "../mcp/schemas.js";
import { LifecycleEvents, type LifecycleEvent } from "../extensions/events.js";

/**
 * Power Bundle Compose (IDEA-F141). A power bundle extends the plugin-bundle
 * manifest shape with optional mcpServers[], steering[], and hooks[] fields —
 * a higher-level composition unit that groups MCP server configs, mid-turn
 * steering patterns, and lifecycle hook registrations into one validated
 * manifest. Validation and planInstall are offline (no network fetch).
 *
 * Composes: F111 plugin bundles · F138 agent hooks · MCP.
 */

export const POWER_BUNDLE_VERSION = 1;

// -- lifecycle event names (closed set from LifecycleEvents) ----------------
const LIFECYCLE_EVENT_VALUES = Object.values(LifecycleEvents) as [string, ...string[]];
const LifecycleEventNameSchema = z.enum(LIFECYCLE_EVENT_VALUES);
export type LifecycleEventName = z.infer<typeof LifecycleEventNameSchema>;

// -- steering descriptor ----------------------------------------------------
export const SteeringDescriptorSchema = z
  .object({
    /** Unique id for this steering rule within the bundle. */
    id: z.string().trim().min(1),
    /** Human label. */
    label: z.string().trim().min(1).max(80),
    /** What triggers this steering injection (a keyword or condition tag). */
    trigger: z.string().trim().min(1),
    /** The steering message template injected mid-turn. */
    template: z.string().trim().min(1),
    notes: z.string().max(500).default("")
  })
  .strict();
export type SteeringDescriptor = z.infer<typeof SteeringDescriptorSchema>;

// -- hook registration ------------------------------------------------------
export const HookRegistrationSchema = z
  .object({
    /** Unique id for this hook registration within the bundle. */
    id: z.string().trim().min(1),
    /** Lifecycle event this hook fires on. */
    event: LifecycleEventNameSchema,
    /** Hook handler reference — a script name resolved under .guru/hooks/. */
    handler: z.string().trim().min(1),
    notes: z.string().max(500).default("")
  })
  .strict();
export type HookRegistration = z.infer<typeof HookRegistrationSchema>;

// -- MCP server entry in a power bundle -------------------------------------
export const PowerMcpServerEntrySchema = z
  .object({
    id: McpServerIdSchema,
    enabled: z.boolean().default(true),
    /** When set, this is a reference to an existing MCP server config by id.
     *  When empty, the entry carries its own inline config. */
    ref: z.string().trim().min(1).optional(),
    /** Inline transport (only when ref is absent). */
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    /** Inline command (stdio only, only when ref is absent). */
    command: z.string().trim().min(1).optional(),
    /** Inline args (only when ref is absent). */
    args: z.array(z.string()).default([]),
    /** Inline URL (http/sse only, only when ref is absent). */
    url: z.string().trim().url().optional(),
    category: z.string().trim().min(1).default("power-bundle"),
    notes: z.string().max(500).default("")
  })
  .strict()
  .superRefine((value, ctx) => {
    // A ref entry needs nothing else validated — it points to an existing config.
    if (value.ref && value.ref.trim().length > 0) return;

    // Inline entry: validate transport-dependent fields.
    if (!value.transport) {
      ctx.addIssue({ code: "custom", path: ["transport"], message: "Inline MCP server entries require a transport." });
      return;
    }
    if (value.transport === "stdio" && !value.command) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "stdio MCP server entries require a command name." });
    }
    if ((value.transport === "http" || value.transport === "sse") && !value.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "HTTP/SSE MCP server entries require a URL." });
    }
  });
export type PowerMcpServerEntry = z.infer<typeof PowerMcpServerEntrySchema>;

// -- power bundle manifest --------------------------------------------------
export const PowerBundleSchema = z
  .object({
    /** Stable unique id for this bundle (kebab-case slug). */
    id: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, "Expected a kebab-case slug."),
    label: z.string().trim().min(1).max(80),
    version: z.string().trim().min(1).default("0.1.0"),
    mcpServers: z.array(PowerMcpServerEntrySchema).default([]),
    steering: z.array(SteeringDescriptorSchema).default([]),
    hooks: z.array(HookRegistrationSchema).default([]),
    notes: z.string().max(2000).default("")
  })
  .strict();
export type PowerBundle = z.infer<typeof PowerBundleSchema>;
