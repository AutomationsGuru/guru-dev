/**
 * AutonomyLevelLadder
 *
 * Maps numeric inputs to autonomy levels 0-3.
 * Level 0: Minimal autonomy (strictest approval required)
 * Level 1: Low autonomy
 * Level 2: Moderate autonomy
 * Level 3: Maximum autonomy — hard limits still enforced, cannot be skipped
 *
 * Hard limits (from VISION.md) are never liftable at any level:
 * 1. No destruction without preservation
 * 2. No unapproved spend
 * 3. No leaked secrets
 * 4. No moral or out-of-scope crossing
 * 5. No ungoverned self-improvement
 */

export interface AutonomyLevel {
  level: number;
  name: string;
  description: string;
  approvalStrictness: 'strict' | 'moderate' | 'lenient' | 'minimal';
  hardLimitsEnforced: boolean;
}

export class AutonomyLevelLadder {
  private static readonly LEVELS: AutonomyLevel[] = [
    {
      level: 0,
      name: 'Restricted',
      description: 'Minimal autonomy; all actions require explicit approval',
      approvalStrictness: 'strict',
      hardLimitsEnforced: true
    },
    {
      level: 1,
      name: 'Supervised',
      description: 'Low autonomy; routine actions allowed with oversight',
      approvalStrictness: 'moderate',
      hardLimitsEnforced: true
    },
    {
      level: 2,
      name: 'Guided',
      description: 'Moderate autonomy; most actions proceed with audit trail',
      approvalStrictness: 'lenient',
      hardLimitsEnforced: true
    },
    {
      level: 3,
      name: 'Autonomous',
      description: 'Maximum autonomy; YOLO-by-default with hard limits enforced',
      approvalStrictness: 'minimal',
      hardLimitsEnforced: true
    }
  ];

  private static readonly TOTAL_LEVELS = 4;

  /**
   * Resolves any numeric input to a valid autonomy level (0-3).
   * Clamps out-of-range values to nearest valid level.
   * Non-numeric or NaN inputs resolve to level 0 (safest default).
   */
  resolveLevel(n: number): number {
    if (!Number.isFinite(n) || Number.isNaN(n)) {
      return 0;
    }
    if (n < 0) {
      return 0;
    }
    if (n > 3) {
      return 3;
    }
    return Math.floor(n);
  }

  /**
   * Returns the AutonomyLevel metadata for a given level number.
   */
  getLevel(level: number): AutonomyLevel {
    const resolved = this.resolveLevel(level);
    return AutonomyLevelLadder.LEVELS[resolved];
  }

  /**
   * Returns true if hard limits are enforced at the given level.
   * Per VISION.md, hard limits are never liftable at any level.
   */
  hasHardLimits(level: number): boolean {
    const resolved = this.resolveLevel(level);
    return AutonomyLevelLadder.LEVELS[resolved].hardLimitsEnforced;
  }

  /**
   * Returns the approval strictness for a given level.
   */
  getApprovalStrictness(level: number): 'strict' | 'moderate' | 'lenient' | 'minimal' {
    const resolved = this.resolveLevel(level);
    return AutonomyLevelLadder.LEVELS[resolved].approvalStrictness;
  }

  /**
   * Returns total number of levels (always 4: 0-3).
   */
  getTotalLevels(): number {
    return AutonomyLevelLadder.TOTAL_LEVELS;
  }

  /**
   * Returns all levels as an array.
   */
  getAllLevels(): AutonomyLevel[] {
    return [...AutonomyLevelLadder.LEVELS];
  }
}
