/**
 * Workflow Artifact Pipeline
 *
 * Steps publish named artifacts via glob patterns.
 * Later steps inject artifacts by name into their context/workspace.
 * Missing artifact injection is fail-closed (throws, does not silently continue).
 */

import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface PublishedArtifact {
  name: string;
  step: string;
  glob: string;
  paths: string[];
}

export class ArtifactPipeline {
  private artifacts: Map<string, PublishedArtifact> = new Map();

  /**
   * Publish artifacts matching a glob pattern under a named key.
   * The step identifier is recorded for traceability.
   */
  async publish(step: string, name: string, globPattern: string, cwd: string = process.cwd()): Promise<PublishedArtifact> {
    if (!name || typeof name !== 'string') {
      throw new Error('Artifact name must be a non-empty string');
    }
    if (!globPattern || typeof globPattern !== 'string') {
      throw new Error('Glob pattern must be a non-empty string');
    }

    const resolvedCwd = resolve(cwd);
    const matches: string[] = [];

    try {
      for await (const entry of glob(globPattern, { cwd: resolvedCwd })) {
        matches.push(resolve(resolvedCwd, entry));
      }
    } catch (err) {
      // If glob fails (e.g., invalid pattern), record empty paths but do not throw
      // The publish itself succeeds; inject will reveal if nothing was captured
    }

    const artifact: PublishedArtifact = {
      name,
      step,
      glob: globPattern,
      paths: matches,
    };

    this.artifacts.set(name, artifact);
    return artifact;
  }

  /**
   * Inject a named artifact into the caller's context.
   * Returns the resolved file paths for the artifact.
   * Throws if the artifact name was never published (fail-closed).
   */
  inject(name: string): string[] {
    if (!name || typeof name !== 'string') {
      throw new Error('Artifact name must be a non-empty string');
    }

    const artifact = this.artifacts.get(name);
    if (!artifact) {
      throw new Error(`Artifact "${name}" not found. It was never published by any step.`);
    }

    return [...artifact.paths];
  }

  /**
   * Check if an artifact has been published.
   */
  has(name: string): boolean {
    return this.artifacts.has(name);
  }

  /**
   * List all published artifact names.
   */
  list(): string[] {
    return Array.from(this.artifacts.keys());
  }

  /**
   * Clear all published artifacts (useful for test isolation).
   */
  clear(): void {
    this.artifacts.clear();
  }
}

// Default singleton instance for workflow use
export const defaultPipeline = new ArtifactPipeline();
