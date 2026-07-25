/**
 * ToolScratchpadStore — in-memory park/resolve for large tool results.
 *
 * When a tool result exceeds a byte threshold, park it under a `scratch:tool:`
 * ref and return a compact pointer string instead of the full body. No disk,
 * no network — pure Map storage for the active session.
 */

import { randomUUID } from "node:crypto";

export type ToolScratchRef = string;
export type ToolScratchPointer = string;

export interface ToolScratchpadOptions {
  readonly createId?: () => string;
}

export interface ToolScratchParkInline {
  readonly parked: false;
  readonly result: string;
  readonly bytes: number;
}

export interface ToolScratchParkStored {
  readonly parked: true;
  readonly ref: ToolScratchRef;
  readonly pointer: ToolScratchPointer;
  readonly bytes: number;
}

export type ToolScratchParkResult = ToolScratchParkInline | ToolScratchParkStored;

const TOOL_SCRATCH_REF_RE = /^scratch:tool:[^:\s]+$/;

export function measureToolResultBytes(result: string): number {
  return Buffer.byteLength(result, "utf8");
}

export function formatToolScratchPointer(ref: ToolScratchRef, bytes: number): string {
  return `[tool-scratchpad ref=${ref} bytes=${bytes}]`;
}

export function isToolScratchRef(value: string): value is ToolScratchRef {
  return TOOL_SCRATCH_REF_RE.test(value);
}

export class ToolScratchpadStore {
  private readonly entries = new Map<ToolScratchRef, string>();
  private readonly createId: () => string;

  constructor(options: ToolScratchpadOptions = {}) {
    this.createId = options.createId ?? randomUUID;
  }

  park(result: string, threshold: number): ToolScratchParkResult {
    if (!Number.isFinite(threshold)) {
      throw new Error("threshold must be a finite number");
    }

    const bytes = measureToolResultBytes(result);

    if (bytes <= threshold) {
      return { parked: false, result, bytes };
    }

    const ref: ToolScratchRef = `scratch:tool:${this.createId()}`;
    this.entries.set(ref, result);

    return {
      parked: true,
      ref,
      pointer: formatToolScratchPointer(ref, bytes),
      bytes
    };
  }

  resolve(ref: ToolScratchRef): string | undefined {
    return this.entries.get(ref);
  }

  has(ref: ToolScratchRef): boolean {
    return this.entries.has(ref);
  }

  delete(ref: ToolScratchRef): boolean {
    return this.entries.delete(ref);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
