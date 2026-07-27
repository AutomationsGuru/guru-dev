// src/session/shadowCheckpointPointer.ts
// Shadow checkpoint pointer for CLI session resume after restart.
// Atomic save, strict base SHA/tree validation, JSONL-capable log (last line wins).
// Per VISION §4.3 (resume semantics) and §5.2 (validation rules).

import { readFile, writeFile, rename, unlink, open, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface CheckpointPointer {
  baseSha: string;
  baseTree: string;
  sessionName: string;
  checkpointPointer: string; // opaque resume token (e.g. last command id or state ref)
  lastCommandIndex?: number;
  timestamp: string; // ISO
}

const POINTER_DIR = '.claude/sessions/checkpoints';

function getPointerPath(sessionName: string): string {
  return path.join(POINTER_DIR, `${sessionName}.pointer.json`);
}

/**
 * Load the current checkpoint pointer for this session if it matches the provided base.
 * Returns null for missing file, stale pointer (SHA/tree mismatch), or parse error.
 * Uses last non-empty line for JSONL resilience.
 */
export async function loadCheckpointPointer(
  baseSha: string,
  baseTree: string,
  sessionName: string
): Promise<CheckpointPointer | null> {
  const pointerPath = getPointerPath(sessionName);
  try {
    const content = await readFile(pointerPath, 'utf8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;

    // last line is current (supports append history or single-record)
    const lastLine = lines[lines.length - 1];
    const pointer = JSON.parse(lastLine) as CheckpointPointer;

    // Strict validation — stale if base changed
    if (pointer.baseSha !== baseSha || pointer.baseTree !== baseTree) {
      return null;
    }
    return pointer;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    // parse or other fs error: treat as no valid pointer (fail-closed)
    return null;
  }
}

/**
 * Atomically save (or update) the checkpoint pointer.
 * Uses tmp + rename + fsync for durability. Cleans tmp on error.
 * Creates parent dir if needed (minimal side-effect for first use).
 */
export async function saveCheckpointPointer(
  baseSha: string,
  baseTree: string,
  sessionName: string,
  checkpointPointer: string,
  lastCommandIndex?: number
): Promise<void> {
  const pointerPath = getPointerPath(sessionName);
  const dir = path.dirname(pointerPath);
  const tmpPath = `${pointerPath}.tmp`;

  const payload: CheckpointPointer = {
    baseSha,
    baseTree,
    sessionName,
    checkpointPointer,
    lastCommandIndex,
    timestamp: new Date().toISOString(),
  };

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(payload) + '\n', 'utf8');

    // durability: fsync the tmp file
    const fd = await open(tmpPath, 'r+');
    await fd.sync();
    await fd.close();

    await rename(tmpPath, pointerPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Clear the pointer file for this session (best-effort).
 * Ignores ENOENT; rethrows other errors.
 */
export async function clearCheckpointPointer(
  baseSha: string,
  baseTree: string,
  sessionName: string
): Promise<void> {
  const pointerPath = getPointerPath(sessionName);
  try {
    await unlink(pointerPath);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Retrieve the raw pointer record (no base validation).
 * Useful for tests or admin inspection. Returns null if absent.
 */
export async function getCheckpointPointer(
  sessionName: string
): Promise<CheckpointPointer | null> {
  const pointerPath = getPointerPath(sessionName);
  try {
    const content = await readFile(pointerPath, 'utf8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]) as CheckpointPointer;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
