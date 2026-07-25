import { resolve } from "node:path";

export interface PathWritePolicy {
  readonly yolo: boolean;
  readonly denyPatterns: readonly string[];
}

/**
 * Applies path denies before YOLO's ordinary write allowance. A deny pattern
 * covers the configured path and every path beneath it.
 */
export function mayWrite(path: string, policy: PathWritePolicy): boolean {
  const target = resolve(path);

  for (const pattern of policy.denyPatterns) {
    const deniedPath = resolve(pattern);
    if (target === deniedPath || target.startsWith(`${deniedPath}/`) || target.startsWith(`${deniedPath}\\`)) {
      return false;
    }
  }

  return policy.yolo;
}
