import { isAbsolute, relative, resolve } from "node:path";

import {
  WorkspaceSandboxOperationSchema,
  WorkspaceSandboxOutcomeSchema,
  WorkspaceSandboxPathClassSchema,
  WorkspaceSandboxPolicySchema,
  type WorkspaceSandboxOperation,
  type WorkspaceSandboxOperationInput,
  type WorkspaceSandboxOutcome,
  type WorkspaceSandboxPathClass,
  type WorkspaceSandboxPolicy,
  type WorkspaceSandboxPolicyInput
} from "./workspaceSandboxSchema.js";

export {
  WorkspaceSandboxOperationSchema,
  WorkspaceSandboxOutcomeSchema,
  WorkspaceSandboxPathClassSchema,
  WorkspaceSandboxPolicySchema
};
export type {
  WorkspaceSandboxOperation,
  WorkspaceSandboxOperationInput,
  WorkspaceSandboxOutcome,
  WorkspaceSandboxPathClass,
  WorkspaceSandboxPolicy,
  WorkspaceSandboxPolicyInput
} from "./workspaceSandboxSchema.js";

/** Hard-limit approval classes are never auto-approved by the workspace policy. */
const HARD_LIMIT_APPROVAL_CLASSES: ReadonlySet<string> = new Set(["destructive", "spend", "secret-edge", "auth-edge"]);

export interface WorkspaceSandboxDecision {
  readonly outcome: WorkspaceSandboxOutcome;
  readonly reason: string;
  readonly pathClass?: WorkspaceSandboxPathClass;
}

/**
 * Classify an absolute or write-root-relative path without filesystem access.
 * A sibling with the same prefix is outside (`/work/repo-copy` is not inside
 * `/work/repo`), and traversal is normalized before the comparison.
 */
export function classifyPath(path: string, writeRoot: string): WorkspaceSandboxPathClass {
  const root = resolve(writeRoot);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const between = relative(root, target);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between)) ? "inside" : "outside";
}

/**
 * Apply the default workspace boundary before F61's class matrix can approve an
 * elevated action. This policy deliberately returns `escalate` for permitted
 * elevation: the F61 approval-class owner decides whether a class is approved.
 * Hard-limit classes deny here, so no later auto-approval can bypass them.
 */
export function evaluateWorkspaceSandbox(
  operation: WorkspaceSandboxOperationInput,
  policy: WorkspaceSandboxPolicyInput
): WorkspaceSandboxDecision {
  const parsedOperation = WorkspaceSandboxOperationSchema.safeParse(operation);
  const parsedPolicy = WorkspaceSandboxPolicySchema.safeParse(policy);
  if (!parsedOperation.success || !parsedPolicy.success) {
    return { outcome: "deny", reason: "invalid workspace sandbox input" };
  }

  if (parsedOperation.data.approvalClass && HARD_LIMIT_APPROVAL_CLASSES.has(parsedOperation.data.approvalClass)) {
    return { outcome: "deny", reason: `hard-limit approval class (${parsedOperation.data.approvalClass}) is never auto-approved` };
  }

  if (parsedOperation.data.kind === "write") {
    const pathClass = classifyPath(parsedOperation.data.path!, parsedPolicy.data.writeRoot);
    if (pathClass === "outside" && !parsedPolicy.data.allowOutsideRoot) {
      return { outcome: "deny", reason: "write target is outside the workspace root", pathClass };
    }
    return {
      outcome: "allow",
      reason: pathClass === "inside" ? "write target is within the workspace root" : "outside-root write is explicitly allowed by workspace policy",
      pathClass
    };
  }

  if (parsedOperation.data.kind === "network" && !parsedPolicy.data.allowNetwork) {
    return { outcome: "escalate", reason: "network access requires an explicit approval class" };
  }

  if (parsedOperation.data.kind === "shell") {
    return { outcome: "escalate", reason: "shell elevation requires an explicit approval class" };
  }

  return { outcome: "allow", reason: "network access is explicitly allowed by workspace policy" };
}
