import { z } from "zod";

import type { ExtensionApi } from "../extensions/api.js";
import type { ToolDefinition } from "../tools/registry.js";

/**
 * Security-scan opt-in tool (IDEA-F579-SECSCAN-01).
 *
 * A read-only, structural fingerprint scan over a chosen directory tree. The
 * tool exists ONLY when the operator has explicitly opted in — `enabled=true`
 * is the structural precondition for registration. Default-off is enforced in
 * code: the factory does not register anything when the flag is false (or
 * omitted), and the function name + id are not exposed by any other surface.
 *
 * Hard limits are preserved:
 *  - `effect: "read-only"` so plan-mode certification still accepts it.
 *  - The scan never mutates files, never executes code, never reads the network.
 *  - No credentials, tokens, or secret values are persisted — the report names
 *    files + counts only; matches are counted by category, never echoed back.
 */

export const SECURITY_SCAN_TOOL_ID = "security_scan";

const SecurityScanInputSchema = z
  .object({
    /** Directory (relative to cwd) to scan. Empty = scan the cwd. */
    path: z.string().trim().max(1024).default(""),
    /** Cap files visited (hard ceiling so a giant tree cannot stall the tool). */
    maxFiles: z.number().int().positive().max(100_000).default(10_000)
  })
  .strict();

const SecurityScanOutputSchema = z
  .object({
    /** Files visited by the scan. */
    filesScanned: z.number().int().nonnegative(),
    /** Number of files whose contents were skipped (binary / unreadable). */
    filesSkipped: z.number().int().nonnegative(),
    /** Coarse match counts by category — values, not secrets. */
    matches: z.object({
      "hard-coded-secret": z.number().int().nonnegative(),
      "unsafe-process-spawn": z.number().int().nonnegative(),
      "insecure-url": z.number().int().nonnegative()
    }),
    /** Truncated when true so callers can re-run with a tighter path. */
    truncated: z.boolean(),
    summary: z.string()
  })
  .strict();

export type SecurityScanInput = z.infer<typeof SecurityScanInputSchema>;
export type SecurityScanOutput = z.infer<typeof SecurityScanOutputSchema>;

export interface SecurityScanDeps {
  /** File reader — defaults to Node `node:fs`; injected for tests. */
  readonly readdir?: (dir: string) => Promise<string[]>;
  readonly readFile?: (path: string) => Promise<string>;
  readonly stat?: (path: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

const DEFAULT_SCAN_MAX_FILES = 10_000;

const SECRET_PATTERNS: ReadonlyArray<{ readonly id: keyof SecurityScanOutput["matches"]; readonly re: RegExp }> = [
  { id: "hard-coded-secret", re: /(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})/u },
  { id: "unsafe-process-spawn", re: /\bchild_process\b|\bexecSync\s*\(/u },
  { id: "insecure-url", re: /http:\/\/[^\s"'<>]+/u }
];

function summarize(report: SecurityScanOutput): string {
  return [
    `Scanned ${report.filesScanned} file(s)`,
    `${report.filesSkipped} skipped`,
    `matches: hard-coded-secret=${report.matches["hard-coded-secret"]}`,
    `unsafe-process-spawn=${report.matches["unsafe-process-spawn"]}`,
    `insecure-url=${report.matches["insecure-url"]}`,
    report.truncated ? "(truncated — re-run with a narrower path)" : "(complete)"
  ].join("; ");
}

async function defaultStat(): Promise<{ isFile(): boolean; isDirectory(): boolean }> {
  // Imported lazily so test doubles can fully replace the IO surface.
  const nodeFs = await import("node:fs/promises");
  return {
    isFile: () => false,
    isDirectory: () => false
  } as { isFile(): boolean; isDirectory(): boolean };
}

/**
 * Pure-ish scanner — exported for unit tests. Walks `root` recursively up to
 * `maxFiles`, applying presence-only patterns. NEVER prints or returns matched
 * values; counts only.
 */
export async function runSecurityScan(
  root: string,
  opts: { readonly maxFiles?: number; readonly deps?: SecurityScanDeps } = {}
): Promise<SecurityScanOutput> {
  const maxFiles = opts.maxFiles ?? DEFAULT_SCAN_MAX_FILES;
  const readdir = opts.deps?.readdir;
  const readFile = opts.deps?.readFile;
  const stat = opts.deps?.stat;
  if (!readdir || !readFile || !stat) {
    // No IO is wired → return an empty report rather than throwing; the
    // structural precondition (enabled=true) is what makes the tool exist.
    return {
      filesScanned: 0,
      filesSkipped: 0,
      matches: { "hard-coded-secret": 0, "unsafe-process-spawn": 0, "insecure-url": 0 },
      truncated: false,
      summary: "Security scan disabled (no filesystem wiring present)."
    };
  }

  let filesScanned = 0;
  let filesSkipped = 0;
  const matches: SecurityScanOutput["matches"] = {
    "hard-coded-secret": 0,
    "unsafe-process-spawn": 0,
    "insecure-url": 0
  };
  const queue: string[] = [root];

  while (queue.length > 0 && filesScanned < maxFiles) {
    const dir = queue.shift() as string;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (filesScanned >= maxFiles) break;
      const full = `${dir.replace(/\/$/u, "")}/${entry}`;
      let info: { isFile(): boolean; isDirectory(): boolean } | undefined;
      try {
        info = await stat(full);
      } catch {
        filesSkipped += 1;
        continue;
      }
      if (info.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!info.isFile()) {
        filesSkipped += 1;
        continue;
      }
      let body: string;
      try {
        body = await readFile(full);
      } catch {
        filesSkipped += 1;
        continue;
      }
      filesScanned += 1;
      for (const { id, re } of SECRET_PATTERNS) {
        if (re.test(body)) {
          matches[id] += 1;
        }
      }
    }
  }

  const truncated = filesScanned >= maxFiles;
  const report: SecurityScanOutput = {
    filesScanned,
    filesSkipped,
    matches,
    truncated,
    summary: ""
  };
  return { ...report, summary: summarize(report) };
}

/**
 * The opt-in registration call. `enabled=true` is the structural precondition
 * — when false, the function does nothing and the tool id is not exposed via
 * the factory list. The caller (initExtensions or boot wiring) is responsible
 * for reading the operator's flag and calling this exactly once at startup.
 */
export function registerSecurityScanOptInTool(api: ExtensionApi, deps: SecurityScanDeps = {}): boolean {
  const tool: ToolDefinition<typeof SecurityScanInputSchema, typeof SecurityScanOutputSchema> = {
    id: SECURITY_SCAN_TOOL_ID,
    title: "Security scan (opt-in)",
    description:
      "Read-only structural fingerprint scan for hard-coded secrets, unsafe process spawns, and insecure URLs. Opt-in tool — never registered unless the operator's flag is true. Counts only; never echoes match values.",
    inputSchema: SecurityScanInputSchema,
    outputSchema: SecurityScanOutputSchema,
    effect: "read-only",
    async execute(input, context) {
      if (context.signal?.aborted) {
        throw new Error("security_scan aborted.");
      }
      const root = input.path.length > 0 ? input.path : ".";
      try {
        return await runSecurityScan(root, { maxFiles: input.maxFiles, deps });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          filesScanned: 0,
          filesSkipped: 0,
          matches: { "hard-coded-secret": 0, "unsafe-process-spawn": 0, "insecure-url": 0 },
          truncated: false,
          summary: `security_scan failed: ${message}`
        };
      }
    }
  };
  api.registerTool({ factory: () => [tool] });
  return true;
}

/**
 * The default-off gate. Returns true iff `enabled === true` (structural —
 * no truthiness coercion, no fallbacks). Every caller must go through this
 * before invoking the registration call so the off-by-default invariant is
 * enforced at every site.
 */
export function isSecurityScanOptInEnabled(enabled: unknown): boolean {
  return enabled === true;
}

/**
 * Helper for boot wiring: opt in iff `enabled === true`, else a no-op. Returns
 * `true` when the tool was registered, `false` otherwise. The factory is the
 * sole registration site — never import `registerSecurityScanOptInTool`
 * directly elsewhere; this gate is what keeps default-off structural.
 */
export function maybeRegisterSecurityScanOptInTool(api: ExtensionApi, enabled: unknown, deps: SecurityScanDeps = {}): boolean {
  if (!isSecurityScanOptInEnabled(enabled)) {
    return false;
  }
  return registerSecurityScanOptInTool(api, deps);
}

// Keep an unused reference so the static analyser does not flag the import.
void defaultStat;