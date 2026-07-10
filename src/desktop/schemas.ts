import { z } from "zod";

/**
 * Guarded desktop / computer-use contracts (PyAutoGUI-class parity).
 * Live input is dry-run-first + userApproved; status is always read-only.
 */

export const DesktopReadinessStatusSchema = z.enum([
  "ready",
  "missing-backend",
  "missing-display",
  "disabled",
  "error",
  "not-implemented"
]);
export type DesktopReadinessStatus = z.infer<typeof DesktopReadinessStatusSchema>;

export const DesktopStatusReportSchema = z
  .object({
    status: DesktopReadinessStatusSchema,
    platform: z.string(),
    displayAvailable: z.boolean(),
    backend: z.enum(["none", "injected", "native-probe"]),
    failsafeEnabled: z.boolean(),
    liveActionsEnabled: z.boolean(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type DesktopStatusReport = z.infer<typeof DesktopStatusReportSchema>;

export const ScreenActionSchema = z.enum(["size", "position", "screenshot", "locate"]);
export type ScreenAction = z.infer<typeof ScreenActionSchema>;

export const DesktopScreenRequestSchema = z
  .object({
    action: ScreenActionSchema,
    /** Required for locate — image path relative to cwd or absolute (sandboxed by adapter). */
    imagePath: z.string().trim().min(1).max(1024).optional(),
    /** When true (default), do not perform OS side effects; return planned result. */
    dryRun: z.boolean().default(true),
    userApproved: z.boolean().default(false),
    /** Screenshot only: write to sidecar path under a temp/workspace dir instead of inline bytes. */
    sidecarPath: z.string().trim().min(1).max(1024).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "locate" && !value.imagePath) {
      ctx.addIssue({ code: "custom", path: ["imagePath"], message: "locate requires imagePath." });
    }
  });
export type DesktopScreenRequest = z.infer<typeof DesktopScreenRequestSchema>;

export const DesktopScreenResultSchema = z
  .object({
    action: ScreenActionSchema,
    status: z.enum(["succeeded", "failed", "blocked", "dry-run"]),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    /** Sidecar screenshot path when written; never embed huge base64 by default. */
    sidecarPath: z.string().optional(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type DesktopScreenResult = z.infer<typeof DesktopScreenResultSchema>;

export const MouseActionSchema = z.enum(["move", "click", "scroll", "position"]);
export type MouseAction = z.infer<typeof MouseActionSchema>;

export const DesktopMouseRequestSchema = z
  .object({
    action: MouseActionSchema,
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    clicks: z.number().int().positive().max(3).default(1),
    scrollClicks: z.number().int().min(-50).max(50).default(0),
    dryRun: z.boolean().default(true),
    userApproved: z.boolean().default(false)
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.action === "move" || value.action === "click") && (value.x === undefined || value.y === undefined)) {
      ctx.addIssue({ code: "custom", path: ["x"], message: "move/click require x and y." });
    }
  });
export type DesktopMouseRequest = z.infer<typeof DesktopMouseRequestSchema>;

export const DesktopMouseResultSchema = z
  .object({
    action: MouseActionSchema,
    status: z.enum(["succeeded", "failed", "blocked", "dry-run"]),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type DesktopMouseResult = z.infer<typeof DesktopMouseResultSchema>;

export const KeyboardActionSchema = z.enum(["type", "hotkey", "press"]);
export type KeyboardAction = z.infer<typeof KeyboardActionSchema>;

export const DesktopKeyboardRequestSchema = z
  .object({
    action: KeyboardActionSchema,
    text: z.string().max(2000).optional(),
    keys: z.array(z.string().trim().min(1).max(32)).max(6).optional(),
    dryRun: z.boolean().default(true),
    userApproved: z.boolean().default(false)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "type" && (value.text === undefined || value.text.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "type requires text." });
    }
    if ((value.action === "hotkey" || value.action === "press") && (!value.keys || value.keys.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["keys"], message: "hotkey/press require keys." });
    }
  });
export type DesktopKeyboardRequest = z.infer<typeof DesktopKeyboardRequestSchema>;

export const DesktopKeyboardResultSchema = z
  .object({
    action: KeyboardActionSchema,
    status: z.enum(["succeeded", "failed", "blocked", "dry-run"]),
    summary: z.string().trim().min(1)
  })
  .strict();
export type DesktopKeyboardResult = z.infer<typeof DesktopKeyboardResultSchema>;
