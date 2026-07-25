// src/watch/commentTaskIngress.ts
// Optional file-watch task ingress: detect operator AI-task comments in watched files
// and enqueue to an in-memory/session queue. Default off, no network.
import { extractTasks } from './commentTaskPatterns.js';
export function createInMemoryQueue() {
    const tasks = [];
    return {
        enqueue(task) {
            tasks.push(task);
        },
        size() {
            return tasks.length;
        },
        drain() {
            const out = tasks.slice();
            tasks.length = 0;
            return out;
        },
    };
}
const DEFAULT_BOUNDS = Object.freeze({
    maxFiles: 100,
    maxBytesPerFile: 256_000,
    maxMs: 5_000,
    maxMatchesPerBatch: 1_000,
});
/**
 * Bounded scan of changed files. Returns extracted tasks, never throws on malformed
 * input; errors are swallowed and reported in the returned diagnostics so a single
 * bad file cannot kill a watch batch.
 *
 * No network. No persistence. Secrets are never loaded or logged by this module;
 * if a file contains a secret inside a task comment, the caller is responsible for
 * scrubbing before enqueue or display.
 */
export function scanChangedFiles(options) {
    const { enabled, queue, changes, markers, bounds = {} } = options;
    const diagnostics = [];
    if (!enabled) {
        return { enqueued: 0, scanned: 0, diagnostics: ['ingress disabled'], aborted: { reason: 'none' } };
    }
    const { maxFiles = DEFAULT_BOUNDS.maxFiles, maxBytesPerFile = DEFAULT_BOUNDS.maxBytesPerFile, maxMs = DEFAULT_BOUNDS.maxMs, maxMatchesPerBatch = DEFAULT_BOUNDS.maxMatchesPerBatch, } = bounds;
    const startMs = performance.now();
    let enqueued = 0;
    let scanned = 0;
    for (let i = 0; i < changes.length && i < maxFiles; i++) {
        if (performance.now() - startMs > maxMs) {
            return {
                enqueued,
                scanned,
                diagnostics: [...diagnostics, `aborted: exceeded ${maxMs}ms wall-clock budget`],
                aborted: { reason: 'time-budget' },
            };
        }
        const change = changes[i];
        if (change === undefined)
            continue;
        const { filePath, content } = change;
        if (content.length > maxBytesPerFile) {
            diagnostics.push(`skipped ${filePath}: exceeds ${maxBytesPerFile} byte limit`);
            continue;
        }
        try {
            const tasks = extractTasks(markers !== undefined ? { filePath, content, markers } : { filePath, content });
            scanned++;
            for (const task of tasks) {
                if (enqueued >= maxMatchesPerBatch) {
                    return {
                        enqueued,
                        scanned,
                        diagnostics: [...diagnostics, `aborted: exceeded ${maxMatchesPerBatch} match limit`],
                        aborted: { reason: 'match-budget' },
                    };
                }
                queue.enqueue(task);
                enqueued++;
            }
        }
        catch (err) {
            diagnostics.push(`error scanning ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return {
        enqueued,
        scanned,
        diagnostics: diagnostics.length ? diagnostics : ['ok'],
        aborted: { reason: 'none' },
    };
}
/**
 * Convenience one-shot: scan and return a fresh queue.
 */
export function ingressCommentTasks(options) {
    const queue = createInMemoryQueue();
    const result = scanChangedFiles({ ...options, queue });
    return { queue, result };
}
