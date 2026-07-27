export type ToolApprovalMode = 'always' | 'never' | 'ask';

export interface Mandate {
  tool?: string;
  action?: string;
  mode: ToolApprovalMode;
}

export interface ApprovalResolution {
  allowed: boolean;
  reason: string;
  mode: ToolApprovalMode;
}

/**
 * Resolves the approval mode for a tool call.
 * Pure function. Precedence: exact tool+action > tool-specific > action-specific > global default (ask).
 * Default is always 'ask' (fail-closed). Never auto-approves protected actions.
 */
export function resolveToolApproval(
  mandates: Mandate[],
  action: string,
  toolName: string
): ApprovalResolution {
  // Filter applicable mandates: those matching tool (or global) and action (or global)
  const applicable = mandates.filter(m =>
    (m.tool === undefined || m.tool === toolName) &&
    (m.action === undefined || m.action === action)
  );

  if (applicable.length === 0) {
    return {
      allowed: false,
      reason: 'No matching mandate; default ask (fail-closed)',
      mode: 'ask'
    };
  }

  // Score specificity: 2=tool+action, 1=tool-only or action-only, 0=global
  const scored = applicable.map(m => {
    const hasTool = m.tool !== undefined;
    const hasAction = m.action !== undefined;
    const score = (hasTool && hasAction) ? 2 : (hasTool || hasAction) ? 1 : 0;
    return { mandate: m, score };
  });

  // Pick highest score (most specific); stable first on tie
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].mandate;

  const allowed = best.mode === 'always';
  const reason = allowed
    ? `Explicit always for ${toolName} on ${action}`
    : best.mode === 'never'
      ? `Explicit never for ${toolName} on ${action}`
      : `Ask required for ${toolName} on ${action} (fail-closed)`;

  return {
    allowed,
    reason,
    mode: best.mode
  };
}
