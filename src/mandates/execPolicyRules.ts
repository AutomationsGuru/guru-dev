import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ExecPolicyConfigSchema, type ExecPolicyConfig } from './execPolicySchema.js';

const HARD_LIMIT_PATTERNS: readonly string[] = [
  'rm -rf *',
  'rm -fr *',
  'rm -rf',
  'rm -rf /',
  'git push --force',
  'git push -f',
  'git push --force *',
  'git push -f *',
  'dd if=*',
  'dd if=',
  'mkfs',
  'mkfs *',
  ':(){ :|:& };:',
  ':(){:|:&};:',
  'sudo rm -rf *',
  'sudo rm -rf /',
  'chmod -R 777 /',
  'chmod 777 /',
  'chmod *777*',
  'curl * | bash',
  'wget * | sh',
  '*rm -rf*',
  'eval *',
  'exec *',
] as const;

function normalizeCmd(cmd: string): string {
  return cmd.trim().toLowerCase().replace(/\s+/g, ' ');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesPattern(cmd: string, pattern: string): boolean {
  const c = normalizeCmd(cmd);
  const p = normalizeCmd(pattern);
  if (!p || !c) return false;
  if (p === c) return true;
  if (p.endsWith(' *')) {
    const prefix = p.slice(0, -2).trimEnd();
    return c.startsWith(prefix);
  }
  if (p.startsWith('* ')) {
    const suffix = p.slice(2).trimStart();
    return c.endsWith(suffix);
  }
  if (p.includes('*')) {
    const parts = p.split('*').map(escapeRegExp);
    const regex = new RegExp('^' + parts.join('.*') + '$', 'i');
    return regex.test(c);
  }
  return false;
}

export function isHardLimit(cmd: string): boolean {
  if (typeof cmd !== 'string') return false;
  return HARD_LIMIT_PATTERNS.some((pattern) => matchesPattern(cmd, pattern));
}

export function loadExecPolicyConfig(projectRoot?: string): ExecPolicyConfig | null {
  const baseDir = projectRoot ? resolve(projectRoot) : process.cwd();
  const candidates: string[] = [
    join(baseDir, '.guru', 'exec-policy.json'),
    join(baseDir, 'exec-policy.json'),
  ];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const content = readFileSync(filePath, 'utf8');
      const parsedJson = JSON.parse(content);
      const validation = ExecPolicyConfigSchema.safeParse(parsedJson);
      if (validation.success) {
        return validation.data;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function matchExecPolicy(
  cmd: string,
  projectRoot?: string
): 'allow' | 'deny' | 'ask' {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return 'ask';
  }
  if (isHardLimit(cmd)) {
    return 'deny';
  }
  const config = loadExecPolicyConfig(projectRoot);
  if (!config || !Array.isArray(config.rules) || config.rules.length === 0) {
    return 'ask';
  }
  for (const rule of config.rules) {
    if (typeof rule.pattern === 'string' && matchesPattern(cmd, rule.pattern)) {
      return rule.action;
    }
  }
  return 'ask';
}

export function canElevate(cmd: string, projectRoot?: string): boolean {
  return matchExecPolicy(cmd, projectRoot) === 'allow';
}