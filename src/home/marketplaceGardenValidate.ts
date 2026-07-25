/**
 * Marketplace Garden validation module.
 * Detects missing skill paths and dead plugin IDs in catalog.
 *
 * @module marketplaceGardenValidate
 */

/**
 * Represents a skill entry in the marketplace garden catalog.
 */
export interface SkillEntry {
  /** Unique skill identifier */
  id: string;
  /** Filesystem path to the skill implementation */
  path: string;
  /** Human-readable skill name */
  name: string;
}

/**
 * Represents a plugin entry in the marketplace garden catalog.
 */
export interface PluginEntry {
  /** Unique plugin identifier */
  id: string;
  /** Plugin name */
  name: string;
  /** Whether the plugin is currently active/enabled */
  active: boolean;
}

/**
 * Input catalog structure for validation.
 */
export interface MarketplaceGardenCatalog {
  /** Array of skill entries to validate */
  skills: SkillEntry[];
  /** Array of plugin entries to validate */
  plugins: PluginEntry[];
}

/**
 * Validation error describing a specific issue found.
 */
export interface ValidationError {
  /** Category of the error */
  type: 'missing-skill-path' | 'dead-plugin-id';
  /** Identifier of the affected item */
  id: string;
  /** Human-readable error message */
  message: string;
  /** Additional context (e.g., the missing path) */
  detail?: string;
}

/**
 * Result of catalog validation.
 */
export interface ValidationResult {
  /** Whether the catalog passed validation (no errors) */
  valid: boolean;
  /** Array of validation errors found (empty if valid) */
  errors: ValidationError[];
}

/**
 * Filesystem existence checker function signature.
 * Implementations should return true if the path exists and is accessible.
 */
export type FsExists = (path: string) => boolean;

/**
 * Validates a marketplace garden catalog.
 *
 * Checks:
 * - All skill paths exist on the filesystem (via fsExists)
 * - All plugin IDs reference active plugins (no dead IDs)
 *
 * @param catalog - The catalog to validate
 * @param fsExists - Function to check filesystem path existence
 * @returns Validation result with any errors found
 */
export function validateMarketplaceGarden(
  catalog: MarketplaceGardenCatalog,
  fsExists: FsExists
): ValidationResult {
  const errors: ValidationError[] = [];

  // Validate skill paths exist
  for (const skill of catalog.skills) {
    if (!fsExists(skill.path)) {
      errors.push({
        type: 'missing-skill-path',
        id: skill.id,
        message: `Skill "${skill.name}" references a missing path`,
        detail: skill.path
      });
    }
  }

  // Validate plugins are active (detect dead plugin IDs)
  for (const plugin of catalog.plugins) {
    if (!plugin.active) {
      errors.push({
        type: 'dead-plugin-id',
        id: plugin.id,
        message: `Plugin "${plugin.name}" is inactive (dead plugin ID)`,
        detail: `plugin ${plugin.id} is not active`
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
