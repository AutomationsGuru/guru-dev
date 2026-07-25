// src/watch/commentTaskIngress.ts
// Optional file-watch task ingress: detect operator AI-task comments in watched files
// and enqueue to an in-memory/session queue. Default off, no network.

import { extractTasks, type CommentTaskMarker, type ExtractedTask } from './commentTaskPatterns.js'

export interface CommentTaskIngressOptions {
  /** Default false — the ingress does nothing when disabled. */
  enabled: boolean
  /** Optional custom markers; defaults to the built-in AI:/guru: markers. */
  markers?: readonly CommentTaskMarker[]
  /**
   * Soft bounds to prevent unbounded scanning during a watch event.
   * These are defaults; callers should keep scans proportionate to the event.
   */
  bounds?: {
    /** Maximum files processed per call. */
    maxFiles?: number
    /** Maximum bytes read per file. */
    maxBytesPerFile?: number
    /** Maximum total wall-clock milliseconds for a scan batch. */
    maxMs?: number
    /** Maximum marker matches to report per call. */
    maxMatchesPerBatch?: number
  }
}

export interface FileChangeEvent {
  filePath: string
  content: string
}

export interface TaskQueue {
  enqueue(task: ExtractedTask): void
  size(): number
  drain(): readonly ExtractedTask[]
}

export function createInMemoryQueue(): TaskQueue {
  const tasks: ExtractedTask[] = []
  return {
    enqueue(task: ExtractedTask) {
      tasks.push(task)
    },
    size() {
      return tasks.length
    },
    drain() {
      const out = tasks.slice()
      tasks.length = 0
      return out
    },
  }
}

const DEFAULT_BOUNDS = Object.freeze({
  maxFiles: 100,
  maxBytesPerFile: 256_000,
  maxMs: 5_000,
  maxMatchesPerBatch: 1_000,
})

/**
 * Bounded scan of changed files. Returns extracted tasks, never throws on malformed
 * input; errors are swallowed and reported in the returned diagnostics so a single
 * bad file cannot kill a watch batch.
 *
 * No network. No persistence. Secrets are never loaded or logged by this module;
 * if a file contains a secret inside a task comment, the caller is responsible for
 * scrubbing before enqueue or display.
 */
export function scanChangedFiles(options: CommentTaskIngressOptions & { queue: TaskQueue; changes: readonly FileChangeEvent[] }): {
  enqueued: number
  scanned: number
  diagnostics: string[]
  aborted: { reason: string }
} {
  const { enabled, queue, changes, markers, bounds = {} } = options
  const diagnostics: string[] = []

  if (!enabled) {
    return { enqueued: 0, scanned: 0, diagnostics: ['ingress disabled'], aborted: { reason: 'none' } }
  }

  const {
    maxFiles = DEFAULT_BOUNDS.maxFiles,
    maxBytesPerFile = DEFAULT_BOUNDS.maxBytesPerFile,
    maxMs = DEFAULT_BOUNDS.maxMs,
    maxMatchesPerBatch = DEFAULT_BOUNDS.maxMatchesPerBatch,
  } = bounds

  const startMs = performance.now()
  let enqueued = 0
  let scanned = 0

  for (let i = 0; i < changes.length && i < maxFiles; i++) {
    if (performance.now() - startMs > maxMs) {
      return {
        enqueued,
        scanned,
        diagnostics: [...diagnostics, `aborted: exceeded ${maxMs}ms wall-clock budget`],
        aborted: { reason: 'time-budget' },
      }
    }

    const change = changes[i]
    if (change === undefined) continue
    const { filePath, content } = change

    if (content.length > maxBytesPerFile) {
      diagnostics.push(`skipped ${filePath}: exceeds ${maxBytesPerFile} byte limit`)
      continue
    }

    try {
      const tasks = extractTasks(
        markers !== undefined ? { filePath, content, markers } : { filePath, content },
      )
      scanned++

      for (const task of tasks) {
        if (enqueued >= maxMatchesPerBatch) {
          return {
            enqueued,
            scanned,
            diagnostics: [...diagnostics, `aborted: exceeded ${maxMatchesPerBatch} match limit`],
            aborted: { reason: 'match-budget' },
          }
        }
        queue.enqueue(task)
        enqueued++
      }
    } catch (err) {
      diagnostics.push(`error scanning ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    enqueued,
    scanned,
    diagnostics: diagnostics.length ? diagnostics : ['ok'],
    aborted: { reason: 'none' },
  }
}

/**
 * Convenience one-shot: scan and return a fresh queue.
 */
export function ingressCommentTasks(options: CommentTaskIngressOptions & { changes: readonly FileChangeEvent[] }): {
  queue: TaskQueue
  result: ReturnType<typeof scanChangedFiles>
} {
  const queue = createInMemoryQueue()
  const result = scanChangedFiles({ ...options, queue })
  return { queue, result }
}
