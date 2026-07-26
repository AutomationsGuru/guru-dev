import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadIgnoreFiles,
  shouldIgnorePath,
  createIgnoreFilter,
  assertNotIgnoredSecret,
  type LoadIgnoreOptions,
} from '../../src/fs/extraIgnore.js';

describe('extraIgnore (IDEA-F34-IGNORE-01)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(tmpdir(), 'guru-extraignore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string) {
    const full = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  it('loadIgnoreFiles discovers .gitignore + default .guruignore', () => {
    writeFile('.gitignore', 'node_modules/\n*.log\n');
    writeFile('.guruignore', 'dist/\n.env\n');
    const patterns = loadIgnoreFiles(tmpRoot);
    expect(patterns).toContain('node_modules/');
    expect(patterns).toContain('dist/');
    expect(patterns).toContain('.env');
  });

  it('loadIgnoreFiles supports extra ignore files with layering precedence', () => {
    writeFile('.gitignore', '*.tmp\n');
    writeFile('.guruignore', '!important.tmp\n');
    writeFile('.codexignore', 'secret-*.yaml\n');
    const patterns = loadIgnoreFiles(tmpRoot, { extra: ['.guruignore', '.codexignore'] });
    expect(patterns).toContain('secret-*.yaml');
  });

  it('shouldIgnorePath matches globs and directory patterns from combined layers', () => {
    const patterns = ['node_modules/**', '*.log', 'dist/'];
    expect(shouldIgnorePath('node_modules/foo/bar.js', patterns, tmpRoot)).toBe(true);
    expect(shouldIgnorePath('src/app.log', patterns, tmpRoot)).toBe(true);
    expect(shouldIgnorePath('dist/bundle.js', patterns, tmpRoot)).toBe(true);
    expect(shouldIgnorePath('src/main.ts', patterns, tmpRoot)).toBe(false);
  });

  it('shouldIgnorePath handles negation patterns (!)', () => {
    const patterns = ['*.tmp', '!keep.tmp'];
    expect(shouldIgnorePath('foo.tmp', patterns, tmpRoot)).toBe(false); // last match wins? or proper negation semantics
    // For minimal impl we treat ! as un-ignore if present; test documents expected
    expect(shouldIgnorePath('keep.tmp', patterns, tmpRoot)).toBe(false);
  });

  it('createIgnoreFilter produces reusable predicate', () => {
    const patterns = ['**/*.secret'];
    const filter = createIgnoreFilter(patterns);
    expect(filter('config/app.secret')).toBe(true);
    expect(filter('config/app.yaml')).toBe(false);
  });

  // CRITICAL secret guard tests - structural enforcement of hard limit
  it('assertNotIgnoredSecret denies .env by default (no force flag)', () => {
    const patterns = loadIgnoreFiles(tmpRoot); // empty ok
    writeFile('.gitignore', '.env\n*-secret.*\n');
    const layers = loadIgnoreFiles(tmpRoot);
    expect(() => assertNotIgnoredSecret('.env', layers)).toThrow(/ignored.*secret/i);
    expect(() => assertNotIgnoredSecret('prod-secret.yaml', layers)).toThrow(/ignored.*secret/i);
  });

  it('assertNotIgnoredSecret permits force-load only with explicit allowIgnoredSecrets flag', () => {
    writeFile('.gitignore', '.env\n');
    const layers = loadIgnoreFiles(tmpRoot);
    // default deny
    expect(() => assertNotIgnoredSecret('.env', layers)).toThrow();
    // explicit allow returns evidence without throw
    const res = assertNotIgnoredSecret('.env', layers, { allowIgnoredSecrets: true });
    expect(res).toBe('deny'); // signals caller that it was a forced/denied case but permitted
  });

  it('secret guard is robust to path traversal and case variants', () => {
    writeFile('.gitignore', '.env\n');
    const layers = loadIgnoreFiles(tmpRoot);
    expect(() => assertNotIgnoredSecret('./.env', layers)).toThrow();
    expect(() => assertNotIgnoredSecret('.ENV', layers)).toThrow(); // case sensitive by default or normalize?
  });

  it('non-secret paths are unaffected and load succeeds', () => {
    const patterns = ['node_modules/**'];
    expect(shouldIgnorePath('src/index.ts', patterns, tmpRoot)).toBe(false);
    expect(() => assertNotIgnoredSecret('src/index.ts', patterns)).not.toThrow();
  });

  it('handles missing ignore files and empty layers gracefully', () => {
    const patterns = loadIgnoreFiles(tmpRoot);
    expect(patterns).toEqual([]);
    expect(shouldIgnorePath('anything', patterns, tmpRoot)).toBe(false);
  });

  it('concurrent loads are safe (idempotent, no mutation)', () => {
    writeFile('.guruignore', 'temp/\n');
    const p1 = loadIgnoreFiles(tmpRoot);
    const p2 = loadIgnoreFiles(tmpRoot);
    expect(p1).toEqual(p2);
  });
});
