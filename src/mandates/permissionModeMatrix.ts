export type PermissionMode = "strict" | "permissive" | "yolo";
export type ToolClass = "read" | "write" | "exec" | "network" | "destructive" | "hard-limit";

/**
 * Maps permission modes to auto-approve classes.
 * Hard-limit tools are always denied auto-approval.
 */
export function mayAuto(mode: PermissionMode, toolClass: ToolClass): boolean {
  if (toolClass === "hard-limit") {
    return false;
  }

  switch (mode) {
    case "strict":
      return false;
    case "permissive":
      return toolClass === "read";
    case "yolo":
      return true;
    default:
      return false;
  }
}
