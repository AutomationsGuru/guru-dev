import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, isAbsolute, resolve } from "node:path";
import {
  PromptTemplateSchema,
  PromptSnippetSchema,
  type PromptTemplate,
  type PromptSnippet,
  type PromptLoader,
} from "./prompts.js";
import { containsSecretValue } from "../safety/secretSafety.js";

interface ParsedPromptFile {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

// Minimal YAML parser
function parsePromptFile(content: string): ParsedPromptFile {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content.trim() };
  }
  const lines = content.split(/\r?\n/);
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex < 0) {
    return { frontmatter: {}, body: content.trim() };
  }
  const frontmatterLines = lines.slice(1, closingIndex);
  const body = lines.slice(closingIndex + 1).join("\n").trim();
  
  const attributes: Record<string, unknown> = {};
  let currentArrayKey: string | undefined = undefined;
  let currentArrayItems: Record<string, unknown>[] = [];
  
  for (let i = 0; i < frontmatterLines.length; i++) {
    const line = frontmatterLines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    // Check if it's an array item
    if (trimmed.startsWith("- ")) {
       if (currentArrayKey) {
           const itemMatch = /-\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(trimmed);
           if (itemMatch) {
               const item: Record<string, unknown> = {};
               item[itemMatch[1] as string] = stripQuotes(itemMatch[2] as string);
               
               // Look ahead for indented properties
               let j = i + 1;
               while (j < frontmatterLines.length && /^\s{2,}\w/.test(frontmatterLines[j] ?? "")) {
                   const subMatch = /([A-Za-z_][\w-]*):\s*(.*)$/.exec((frontmatterLines[j] ?? "").trim());
                   if (subMatch) {
                       item[subMatch[1] as string] = stripQuotes(subMatch[2] as string);
                   }
                   j++;
               }
               currentArrayItems.push(item);
               i = j - 1;
               continue;
           }
       }
    } else {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(trimmed);
        if (kv) {
            const [, key = "", rest = ""] = kv;
            if (rest.trim() === "") {
               currentArrayKey = key;
               currentArrayItems = [];
               attributes[key] = currentArrayItems;
            } else {
               attributes[key] = stripQuotes(rest.trim());
               currentArrayKey = undefined;
            }
        }
    }
  }
  
  return { frontmatter: attributes, body };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseVariables(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
      const rec = item as Record<string, unknown>;
      return {
          name: rec.name,
          description: rec.description,
          required: rec.required === "true" || rec.required === true,
          default: rec.default
      };
  });
}

function parseTags(value: unknown): string[] {
    if (typeof value === "string") {
        if (value.startsWith("[") && value.endsWith("]")) {
            return value.slice(1, -1).split(",").map(v => stripQuotes(v.trim())).filter(Boolean);
        }
        return [value];
    }
    if (Array.isArray(value)) {
        return value.map(String);
    }
    return [];
}

export function createPromptLoader(roots: readonly string[]): PromptLoader {
  const absoluteRoots = roots.map(root => isAbsolute(root) ? root : resolve(root));
  
  async function loadAll(): Promise<{ templates: PromptTemplate[], snippets: PromptSnippet[] }> {
    const templates: PromptTemplate[] = [];
    const snippets: PromptSnippet[] = [];
    const seenTemplateIds = new Set<string>();
    const seenSnippetIds = new Set<string>();

    for (const root of absoluteRoots) {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      
      const files: string[] = [];
      try {
        files.push(...readdirSync(root));
      } catch {
        continue;
      }
      
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const fullPath = join(root, file);
        if (!statSync(fullPath).isFile()) continue;
        
        try {
          const content = readFileSync(fullPath, "utf8");
          const parsed = parsePromptFile(content);
          
          if (containsSecretValue(parsed.body)) {
             throw new Error(`Secret material detected in prompt file: ${fullPath}`);
          }
          
          const kind = typeof parsed.frontmatter.kind === "string" && parsed.frontmatter.kind === "snippet" ? "snippet" : "template";
          const id = typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id ? parsed.frontmatter.id : file.replace(/\.md$/, "");
          
          if (kind === "template") {
              if (seenTemplateIds.has(id)) continue;
              const template = PromptTemplateSchema.parse({
                  id,
                  name: typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : id,
                  description: parsed.frontmatter.description,
                  variables: parseVariables(parsed.frontmatter.variables || parsed.frontmatter.args),
                  body: parsed.body,
                  trust: parsed.frontmatter.trust || "untrusted",
                  scope: parsed.frontmatter.scope || "project",
                  sourcePath: fullPath,
                  tags: parseTags(parsed.frontmatter.tags)
              });
              templates.push(template);
              seenTemplateIds.add(id);
          } else {
              if (seenSnippetIds.has(id)) continue;
              const snippet = PromptSnippetSchema.parse({
                  id,
                  toolId: parsed.frontmatter.toolId,
                  trigger: parsed.frontmatter.trigger,
                  body: parsed.body,
                  trust: parsed.frontmatter.trust || "untrusted",
                  scope: parsed.frontmatter.scope || "project"
              });
              snippets.push(snippet);
              seenSnippetIds.add(id);
          }
        } catch (error) {
          // Skip on parse failure or secret detection just like templates.ts
          // For now, logging to console could be noisy. We'll throw or silently skip?
          // The old discovery skips malformed ones, but here we might want to propagate.
          // Since loader is called programmatically, let's keep skipping invalid ones like templates.ts.
          // Though D4.5TODO says "scan ... at load time", maybe we throw.
          // Wait, returning rejected promise?
          // I'll silently skip invalid files but throw on secret if we want?
          // Actually, let's console.error it for debugging.
          console.error(`PromptLoader error for ${fullPath}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
    
    return { templates, snippets };
  }

  return {
    roots: absoluteRoots,
    list: async () => (await loadAll()).templates,
    get: async (id: string) => (await loadAll()).templates.find(t => t.id === id),
    listSnippets: async () => (await loadAll()).snippets,
    getSnippet: async (id: string) => (await loadAll()).snippets.find(s => s.id === id)
  };
}
