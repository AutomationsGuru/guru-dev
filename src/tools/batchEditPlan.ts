/**
 * Batch edit plan — preflight validation for a list of {path, old, new} edits.
 *
 * Validates each patch is well-formed and rejects overlapping same-path entries
 * so a downstream executor can apply them in order without path-level conflicts.
 *
 * This is a pure validation function; it does NOT read or write files.
 */

export interface BatchEditPatch {
  readonly path: string;
  readonly old: string;
  readonly new: string;
}

export interface BatchEditPlanResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly patches: readonly BatchEditPatch[];
}

/**
 * Validate a batch of edit patches.
 *
 * Rejects:
 * - Empty patch list
 * - Any patch with an empty/whitespace-only path
 * - Any patch with an empty/whitespace-only `old` text (new may be empty — that
 *   is a deletion)
 * - Two or more patches targeting the same path (overlap)
 */
export function validateBatchEditPlan(
  patches: readonly BatchEditPatch[]
): BatchEditPlanResult {
  const errors: string[] = [];

  // 1. Empty list check.
  if (patches.length === 0) {
    return {
      valid: false,
      errors: ["Batch edit plan is empty: at least one patch is required."],
      patches
    };
  }

  // 2. Per-patch validation.
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i]!;
    const label = `Patch #${i + 1}`;

    if (typeof patch.path !== "string" || patch.path.trim().length === 0) {
      errors.push(`${label}: path is required and must not be empty.`);
    }

    if (typeof patch.old !== "string" || patch.old.trim().length === 0) {
      errors.push(`${label}: old text is required and must not be empty.`);
    }
  }

  // 3. Overlap detection — same path appearing more than once.
  const pathSeen = new Map<string, number>(); // path → first index (1-based)
  for (let i = 0; i < patches.length; i++) {
    const path = patches[i]!.path.trim();
    if (path.length === 0) continue; // already flagged above

    const firstIndex = pathSeen.get(path);
    if (firstIndex !== undefined) {
      errors.push(
        `Overlapping patches on path "${path}": Patch #${firstIndex} and Patch #${i + 1} target the same file.`
      );
    } else {
      pathSeen.set(path, i + 1);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, patches };
  }

  return { valid: true, errors: [], patches };
}