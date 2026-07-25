import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import { scrubSecretValuesReport } from "../safety/secretSafety.js";

/**
 * Opt-in session export (IDEA-E5, R-OC-SHARE / R-PI-SHARE).
 *
 * LOCAL-ONLY BY CONSTRUCTION: this module has no network, cloud, or share path.
 * It renders a conversation record to JSON or Markdown text and writes it to a
 * local directory chosen by the operator. There is no "default cloud share"
 * (plan exclusion) — sharing, if the operator wants it, is their own later move.
 *
 * SECRET SCRUB AT THE STRUCTURAL CHOKE POINT (VISION §3.3): every exported
 * string passes through `scrubSecretValuesReport` — shape patterns, registered
 * resolved-credential values, and secret-word assignments — before it becomes
 * a bundle. The rule is enforced here in code, not left to a prompt: a session
 * export can never carry a credential value out of the harness boundary.
 */

export const EXPORT_FORMATS = ["json", "markdown"] as const;
export const ExportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

const ExportMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string()
});

/** Mirrors the durable conversation record shape; kept local so export stays a pure function of its input. */
export const ExportSessionRecordSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  routeId: z.string().trim().min(1).nullable(),
  modelIdOverride: z.string().trim().min(1).nullable().optional(),
  messages: z.array(ExportMessageSchema),
  turnCount: z.number().int().nonnegative(),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1)
});
export type ExportSessionRecord = z.infer<typeof ExportSessionRecordSchema>;

export interface ExportBundle {
  readonly format: ExportFormat;
  /** Fully scrubbed export text — safe to write or hand to the operator. */
  readonly contents: string;
  /** Sanitized file name (no path separators, no traversal). */
  readonly suggestedFileName: string;
  /** True when the scrubber redacted anything — surfaced honestly to the operator. */
  readonly scrubbed: boolean;
  /** Pattern NAMES that fired (never values), for the operator-facing note. */
  readonly scrubPatterns: readonly string[];
}

export interface WriteExportResult {
  readonly filePath: string;
  readonly bytes: number;
  readonly scrubbed: boolean;
}

function sanitizeFileComponent(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return cleaned.length > 0 ? cleaned : "session";
}

/** Scrub collector: per-field scrubs and the final document scrub all feed one match set. */
interface ScrubCollector {
  readonly matched: Set<string>;
}

function scrubInto(collector: ScrubCollector, text: string): string {
  const result = scrubSecretValuesReport(text);
  for (const name of result.matched) {
    collector.matched.add(name);
  }
  return result.text;
}

function buildJson(collector: ScrubCollector, record: ExportSessionRecord): string {
  const title = scrubInto(collector, record.title);
  const messages = record.messages.map((message) => ({
    role: message.role,
    content: scrubInto(collector, message.content)
  }));
  return JSON.stringify(
    {
      id: sanitizeFileComponent(record.id),
      title,
      routeId: record.routeId,
      modelIdOverride: record.modelIdOverride ?? null,
      turnCount: record.turnCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      exportedBy: "GuruHarness",
      exportFormat: "json",
      messages
    },
    null,
    2
  );
}

function buildMarkdown(collector: ScrubCollector, record: ExportSessionRecord): string {
  const title = scrubInto(collector, record.title);
  const lines: string[] = [
    `# ${title}`,
    "",
    `- Session: ${sanitizeFileComponent(record.id)}`,
    `- Route: ${record.routeId ?? "unknown"}`,
    `- Turns: ${record.turnCount}`,
    `- Created: ${record.createdAt}`,
    `- Updated: ${record.updatedAt}`,
    ""
  ];
  for (const message of record.messages) {
    lines.push(`## ${message.role}`, "", scrubInto(collector, message.content), "");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render a session record into a scrubbed, local-only export bundle.
 * Throws (zod) on a malformed record — a partial/invalid export is never produced.
 */
export function buildSessionExport(record: ExportSessionRecord, options: { readonly format: ExportFormat }): ExportBundle {
  const parsed = ExportSessionRecordSchema.parse(record);
  const collector: ScrubCollector = { matched: new Set<string>() };
  const raw = options.format === "json" ? buildJson(collector, parsed) : buildMarkdown(collector, parsed);
  // Final whole-document scrub: defense in depth at the single choke point, so
  // any future field added above still cannot leak a value.
  const final = scrubInto(collector, raw);
  const base = sanitizeFileComponent(parsed.id);
  const matched = [...collector.matched];
  return {
    format: options.format,
    contents: final,
    suggestedFileName: `${base}.${options.format === "json" ? "json" : "md"}`,
    scrubbed: matched.length > 0,
    scrubPatterns: matched
  };
}

/**
 * Write a bundle to a local directory. Refuses to overwrite an existing file
 * (no destruction without preservation) and never escapes the target directory.
 */
export function writeSessionExport(bundle: ExportBundle, options: { readonly directory: string }): WriteExportResult {
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, sanitizeFileComponent(bundle.suggestedFileName.replace(/\.(json|md)$/u, "")) + (bundle.format === "json" ? ".json" : ".md"));
  if (!filePath.startsWith(directory)) {
    throw new Error("export path escapes the target directory (refused)");
  }
  if (existsSync(filePath)) {
    throw new Error(`export file already exists: ${filePath} (refusing to overwrite)`);
  }
  writeFileSync(filePath, bundle.contents, { encoding: "utf8", flag: "wx" });
  return { filePath, bytes: Buffer.byteLength(bundle.contents, "utf8"), scrubbed: bundle.scrubbed };
}
