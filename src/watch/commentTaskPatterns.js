// src/watch/commentTaskPatterns.ts
// Pattern factory for AI-task comment markers. Lightweight, default-off, no network.
import { z } from 'zod';
export const CommentTaskMarkerSchema = z.object({
    prefix: z.string().min(1),
    caseSensitive: z.boolean().default(false),
});
const DEFAULT_MARKERS = Object.freeze([
    { prefix: 'AI:', caseSensitive: false },
    { prefix: 'guru:', caseSensitive: false },
]);
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Build a per-marker pattern that matches an optional common comment leader,
 * optional whitespace, the marker prefix, optional whitespace, and captures the
 * remainder of the line as the task text.
 */
function buildMarkerPattern(marker) {
    const prefix = escapeRegExp(marker.prefix);
    // Common comment leaders: //, #, /*, *, <!--, --, {, ( style comments.
    // `<!--` is listed before `--` so the longer HTML/XML opener wins.
    const leader = `(?:\\s*(?://|#|/\\*|\\*|<!--|--|\\{|\\(|\\{\*|\(\*)\\s*)?`;
    const pattern = `^${leader}(?:${prefix})\\s*(.*)$`;
    const flags = marker.caseSensitive ? 'gm' : 'gmi';
    return new RegExp(pattern, flags);
}
/**
 * Strip a trailing comment closer (star-slash or `-->`) and surrounding
 * whitespace so a block/HTML comment task yields only the task text (no
 * trailing closer). Line-comment forms have no closer and are unaffected.
 */
function trimTrailingCloser(text) {
    return text.replace(/\s*(?:\*\/|-->)\s*$/u, '').trimEnd();
}
export function defaultMarkers() {
    return DEFAULT_MARKERS;
}
/**
 * Extract AI-task comments from file content.
 * Scans line-by-line with bounded input (caller controls source/files).
 * No network, no persistence, no secret handling — caller must filter secrets.
 */
export function extractTasks(options) {
    const { filePath, content, markers = DEFAULT_MARKERS } = options;
    if (!markers.length)
        return [];
    const found = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined)
            continue;
        for (const marker of markers) {
            const pattern = buildMarkerPattern(marker);
            pattern.lastIndex = 0;
            const match = pattern.exec(line);
            if (match) {
                const text = trimTrailingCloser(match[1] ?? '');
                if (text) {
                    found.push({
                        filePath,
                        line: i + 1,
                        column: match[0].indexOf(marker.prefix) + 1 || 1,
                        marker: match[0].trim(),
                        text,
                    });
                }
                // Only the first matching marker on this line.
                break;
            }
        }
    }
    return found;
}
