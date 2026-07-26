import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LoadIgnoreOptions {
  extra?: readonly string[];
}

export interface IgnoreLayer {
  source: string;
  patterns: string[];
}

export function loadIgnoreFiles(
  rootDir: string,
  options: LoadIgnoreOptions = {}
): string[] {
  const extras = options.extra ?? ['.guruignore'];
  const allPatterns: string[] = [];

  // Layer 1: .gitignore
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    allPatterns.push(...parseIgnoreContent(content));
  }

  // Layer 2+: extra ignore files (e.g. .guruignore)
  for (const name of extras) {
    const p = path.join(rootDir, name);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      allPatterns.push(...parseIgnoreContent(content));
    }
  }

  return allPatterns;
}

function parseIgnoreContent(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function shouldIgnorePath(
  targetPath: string,
  patterns: readonly string[],
  rootDir = process.cwd()
): boolean {
  const rel = path.relative(rootDir, targetPath).split(path.sep).join('/');
  const norm = rel.startsWith('./') ? rel.slice(2) : rel;

  // Simple last-match-wins for negation support (!)
  let ignored = false;
  for (const pat of patterns) {
    if (pat.startsWith('!')) {
      const positive = pat.slice(1);
      if (matchIgnorePattern(norm, positive)) {
        ignored = false;
      }
    } else if (matchIgnorePattern(norm, pat)) {
      ignored = true;
    }
  }
  return ignored;
}

function matchIgnorePattern(relPath: string, pattern: string): boolean {
  if (!pattern || !relPath) return false;
  const p = pattern.replace(/\/$/, '');
  if (p === relPath || relPath.startsWith(p + '/')) return true;

  // Support ** , * , ?
  const reSrc =
    '^' +
    p
      .replace(/\*\*/g, '.*')
      .replace(/(?<!\.)\*/g, '[^/]*')
      .replace(/\?/g, '.') +
    '(/.*)?$';
  try {
    return new RegExp(reSrc).test(relPath);
  } catch {
    return p === relPath; // fallback
  }
}

export function createIgnoreFilter(patterns: readonly string[]) {
  return (targetPath: string): boolean => shouldIgnorePath(targetPath, patterns);
}

export interface SecretGuardOptions {
  allowIgnoredSecrets?: boolean;
}

/**
 * Hard-limit enforcement: No leaked secrets.
 * By default denies (throws) any attempt to consider loading a path that matches ignore patterns
 * and is likely a secret file. Only with explicit allowIgnoredSecrets flag does it permit
 * and return 'deny' marker for caller to log/audit.
 */
export function assertNotIgnoredSecret(
  secretCandidatePath: string,
  patterns: readonly string[],
  options: SecretGuardOptions = {}
): void | 'deny' {
  const isIgnored = shouldIgnorePath(secretCandidatePath, patterns);
  if (isIgnored) {
    if (options.allowIgnoredSecrets === true) {
      return 'deny';
    }
    throw new Error(
      `Refusing to force-load ignored secret path "${secretCandidatePath}" (matches ignore layer). Use explicit allowIgnoredSecrets flag only when operator-approved.`
    );
  }
}
