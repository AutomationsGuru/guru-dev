export type SandboxMode = "off" | "workspace-write" | "full";
export type ApprovalPolicy = "on-request" | "auto-approve" | "never";

export interface DualSafetyPosture {
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalPolicy;
}

export const DEFAULT_DUAL_SAFETY_POSTURE: DualSafetyPosture = {
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request"
};

export function withSandbox(
  posture: DualSafetyPosture,
  sandboxMode: SandboxMode
): DualSafetyPosture {
  return { ...posture, sandboxMode };
}

export function withApproval(
  posture: DualSafetyPosture,
  approvalPolicy: ApprovalPolicy
): DualSafetyPosture {
  return { ...posture, approvalPolicy };
}

export function validate(posture: DualSafetyPosture): boolean {
  const validSandboxes: readonly SandboxMode[] = ["off", "workspace-write", "full"];
  const validApprovals: readonly ApprovalPolicy[] = ["on-request", "auto-approve", "never"];
  if (
    !validSandboxes.includes(posture.sandboxMode) ||
    !validApprovals.includes(posture.approvalPolicy)
  ) {
    return false;
  }
  // Reject invalid combos that would allow override of hard limits (lightweight enforcement)
  if (posture.sandboxMode === "full" && posture.approvalPolicy === "auto-approve") {
    return false;
  }
  return true;
}

export function combine(
  sandboxMode: SandboxMode,
  approvalPolicy: ApprovalPolicy
): DualSafetyPosture {
  const posture: DualSafetyPosture = { sandboxMode, approvalPolicy };
  if (!validate(posture)) {
    throw new Error(`Invalid dual safety combo: ${sandboxMode} + ${approvalPolicy}`);
  }
  return posture;
}
