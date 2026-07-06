import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Prompt templates (Composer Completion wave, ADR 2026-07-05-composer-completion).
 * Markdown files with a frontmatter arg schema, invoked as `/name arg…`. Pure
 * discovery + expansion; the REPL wires invocation and the Guru-native
 * $CONTEXT/$SUIT/$TREE expansions.
 */

export interface TemplateArg {
  readonly name: string;
  readonly required: boolean;
  readonly default?: string;
  readonly description?: string;
}

export interface PromptTemplate {
  readonly name: string;
  readonly description: string;
  readonly args: readonly TemplateArg[];
  readonly body: string;
  readonly source: string;
}

/** Default discovery roots: project `.guru/agent/prompts`, then user-level. */
export function defaultTemplateRoots(cwd: string = process.cwd()): readonly string[] {
  return [join(cwd, ".guru", "agent", "prompts"), join(homedir(), ".guru", "agent", "prompts")];
}

export function discoverPromptTemplates(roots: readonly string[] = defaultTemplateRoots()): readonly PromptTemplate[] {
  const byName = new Map<string, PromptTemplate>();
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const full = join(root, entry);
      try {
        if (!statSync(full).isFile()) {
          continue;
        }
        const template = parseTemplate(readFileSync(full, "utf8"), entry.replace(/\.md$/u, ""), full);
        // Project roots come first — first writer wins (project overrides user).
        if (!byName.has(template.name)) {
          byName.set(template.name, template);
        }
      } catch {
        // Skip malformed templates rather than failing discovery.
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse frontmatter + body. Frontmatter is a tiny YAML subset (name/description/args). */
export function parseTemplate(content: string, fallbackName: string, source: string): PromptTemplate {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(content);
  const frontmatter = match ? match[1] ?? "" : "";
  const body = (match ? match[2] ?? "" : content).trim();
  const meta = parseFrontmatter(frontmatter);
  return {
    name: typeof meta.name === "string" && meta.name.length > 0 ? meta.name : fallbackName,
    description: typeof meta.description === "string" ? meta.description : "",
    args: parseArgs(meta.args),
    body,
    source
  };
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/u);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line);
    if (!kv) {
      i += 1;
      continue;
    }
    const [, key = "", rest = ""] = kv;
    if (key === "args" && rest.trim().length === 0) {
      // Collect the following indented `- name: …` block.
      const items: Record<string, string>[] = [];
      i += 1;
      while (i < lines.length && /^\s+-\s/u.test(lines[i] ?? "")) {
        const item: Record<string, string> = {};
        const first = /-\s*(\w[\w-]*):\s*(.*)$/u.exec(lines[i] ?? "");
        if (first) {
          item[first[1] as string] = stripQuotes(first[2] ?? "");
        }
        i += 1;
        while (i < lines.length && /^\s{4,}\w[\w-]*:/u.test(lines[i] ?? "")) {
          const sub = /(\w[\w-]*):\s*(.*)$/u.exec(lines[i] ?? "");
          if (sub) {
            item[sub[1] as string] = stripQuotes(sub[2] ?? "");
          }
          i += 1;
        }
        items.push(item);
      }
      out.args = items;
      continue;
    }
    out[key] = stripQuotes(rest.trim());
    i += 1;
  }
  return out;
}

function parseArgs(value: unknown): readonly TemplateArg[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): TemplateArg[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (name.length === 0) {
      return [];
    }
    return [
      {
        name,
        required: record.required === "true" || record.required === true,
        ...(typeof record.default === "string" && record.default.length > 0 ? { default: record.default } : {}),
        ...(typeof record.description === "string" ? { description: record.description } : {})
      }
    ];
  });
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export interface ExpandTemplateResult {
  readonly text: string;
  /** Required args with no value supplied and no default (blocks send). */
  readonly missing: readonly string[];
}

export interface TemplateExpansionContext {
  /** $CONTEXT — the boot memory block. */
  readonly context?: string;
  /** $SUIT — the active role/suit label. */
  readonly suit?: string;
  /** $TREE — a short repo tree. */
  readonly tree?: string;
}

/**
 * Expand a template body against positional args and the Guru-native context.
 * Positional args map to declared arg names in order; `--name value` and
 * `name=value` forms also bind by name. Missing required args are reported.
 */
export function expandTemplate(template: PromptTemplate, rawArgs: readonly string[], ctx: TemplateExpansionContext = {}): ExpandTemplateResult {
  const values = bindArgs(template.args, rawArgs);
  const missing = template.args.filter((arg) => arg.required && (values.get(arg.name) ?? "").length === 0).map((arg) => arg.name);

  // Collect every placeholder → value mapping first, then substitute in ONE
  // pass so inserted content is literal and can never be re-expanded (e.g. an
  // arg value containing "$CONTEXT" or "{{2}}" stays as-is).
  const replacements = new Map<string, string>();
  for (const arg of template.args) {
    replacements.set(`{{${arg.name}}}`, values.get(arg.name) ?? arg.default ?? "");
  }
  // Positional {{1}} {{2}} … and {{@}} (all args joined).
  rawArgs.forEach((value, index) => replacements.set(`{{${index + 1}}}`, value));
  replacements.set("{{@}}", rawArgs.join(" "));
  // Guru-native expansions.
  replacements.set("$CONTEXT", ctx.context ?? "");
  replacements.set("$SUIT", ctx.suit ?? "");
  replacements.set("$TREE", ctx.tree ?? "");
  const pattern = new RegExp([...replacements.keys()].map((key) => key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu");
  const text = template.body.replace(pattern, (match) => replacements.get(match) ?? match);
  return { text: text.trim(), missing };
}

function bindArgs(schema: readonly TemplateArg[], rawArgs: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (const token of rawArgs) {
    const named = /^--([\w-]+)=(.*)$/u.exec(token) ?? /^([\w-]+)=(.*)$/u.exec(token);
    if (named) {
      values.set(named[1] as string, named[2] as string);
    } else {
      positional.push(token);
    }
  }
  // Fill declared args positionally in order (skipping ones already named).
  let p = 0;
  for (const arg of schema) {
    if (values.has(arg.name)) {
      continue;
    }
    if (p < positional.length) {
      values.set(arg.name, positional[p] as string);
      p += 1;
    }
  }
  return values;
}
