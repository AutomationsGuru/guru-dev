import {
  AutoApproveClassSchema,
  AutoApproveConfigSchema,
  DEFAULT_AUTO_APPROVE_CONFIG,
  HARD_LIMIT_AUTO_APPROVE_CLASSES,
  GATED_AUTO_APPROVE_CLASSES,
  type AutoApproveClass,
  type AutoApproveConfig
} from "./autoApproveSchema.js";

export {
  AutoApproveClassSchema,
  AutoApproveConfigSchema,
  DEFAULT_AUTO_APPROVE_CONFIG,
  HARD_LIMIT_AUTO_APPROVE_CLASSES,
  GATED_AUTO_APPROVE_CLASSES
};
export type { AutoApproveClass, AutoApproveConfig, AutoApproveToolClass } from "./autoApproveSchema.js";

const GATED_CLASSES: ReadonlySet<AutoApproveClass> = new Set(GATED_AUTO_APPROVE_CLASSES);

/**
 * Return whether a classified tool call may skip the interactive approval.
 * Hard-limit classes are checked first and always return false, even when a
 * malformed caller config or a YOLO-derived map claims they are enabled.
 */
export function mayAuto(toolClass: AutoApproveClass, config: AutoApproveConfig = DEFAULT_AUTO_APPROVE_CONFIG): boolean {
  const parsed = AutoApproveConfigSchema.safeParse(config);
  if (!parsed.success || !AutoApproveClassSchema.safeParse(toolClass).success) {
    return false;
  }
  if (GATED_CLASSES.has(toolClass)) {
    return false;
  }
  return parsed.data[toolClass];
}
