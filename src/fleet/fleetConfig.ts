import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { z } from "zod";

const FleetToolSchema = z
  .object({
    description: z.string().trim().min(1).optional()
  })
  .strict();

const FleetRoleSchema = z
  .object({
    tools: z.array(z.string().trim().min(1)).default([]),
    modelSlot: z.string().trim().min(1).optional()
  })
  .strict();

const FleetModelSlotSchema = z
  .object({
    routeId: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional()
  })
  .strict()
  .refine((slot) => slot.routeId !== undefined || (slot.provider !== undefined && slot.model !== undefined), {
    message: "Model slot must provide routeId or provider + model."
  });

const FleetAgentSchema = z
  .object({
    name: z.string().trim().min(1),
    role: z.string().trim().min(1),
    tools: z.array(z.string().trim().min(1)).default([]),
    modelSlot: z.string().trim().min(1).optional()
  })
  .strict();

export const FleetConfigSchema = z
  .object({
    tools: z.record(z.string().trim().min(1), FleetToolSchema).default({}),
    roles: z.record(z.string().trim().min(1), FleetRoleSchema).default({}),
    modelSlots: z.record(z.string().trim().min(1), FleetModelSlotSchema).default({}),
    agents: z.array(FleetAgentSchema).default([])
  })
  .strict()
  .superRefine((config, context) => {
    if (config.agents.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["agents"],
        message: "Fleet config must define at least one agent."
      });
    }

    for (const [index, agent] of config.agents.entries()) {
      if (!(agent.role in config.roles)) {
        context.addIssue({
          code: "custom",
          path: ["agents", index, "role"],
          message: `Agent role \"${agent.role}\" is not declared in roles.`
        });
      }

      if (agent.modelSlot && !(agent.modelSlot in config.modelSlots)) {
        context.addIssue({
          code: "custom",
          path: ["agents", index, "modelSlot"],
          message: `Agent modelSlot \"${agent.modelSlot}\" is not declared in modelSlots.`
        });
      }

      for (const toolId of agent.tools) {
        if (!(toolId in config.tools)) {
          context.addIssue({
            code: "custom",
            path: ["agents", index, "tools"],
            message: `Agent tool \"${toolId}\" is not declared in tools.`
          });
        }
      }
    }

    for (const [roleId, role] of Object.entries(config.roles)) {
      if (role.modelSlot && !(role.modelSlot in config.modelSlots)) {
        context.addIssue({
          code: "custom",
          path: ["roles", roleId, "modelSlot"],
          message: `Role modelSlot \"${role.modelSlot}\" is not declared in modelSlots.`
        });
      }

      for (const toolId of role.tools) {
        if (!(toolId in config.tools)) {
          context.addIssue({
            code: "custom",
            path: ["roles", roleId, "tools"],
            message: `Role tool \"${toolId}\" is not declared in tools.`
          });
        }
      }
    }
  });

export type FleetConfig = z.infer<typeof FleetConfigSchema>;

export function parseFleetConfig(configPath: string): FleetConfig {
  const rawText = readFileSync(configPath, "utf8");
  const extension = extname(configPath).toLowerCase();
  const rawConfig = extension === ".toml" ? parseToml(rawText) : JSON.parse(stripBom(rawText));
  return FleetConfigSchema.parse(rawConfig);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

type TomlPrimitive = string | string[];
type TomlTable = Record<string, TomlValue>;
type TomlValue = TomlPrimitive | TomlTable | TomlTable[];

function parseToml(input: string): Record<string, unknown> {
  const root: TomlTable = {};
  let current: TomlTable | undefined;

  for (const rawLine of input.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("[[") && line.endsWith("]]")) {
      const path = line.slice(2, -2).trim();
      const target = getOrCreateArrayTable(root, path);
      const item: TomlTable = {};
      target.push(item);
      current = item;
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      const path = line.slice(1, -1).trim();
      current = getOrCreateTable(root, path);
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`Unsupported TOML line: ${line}`);
    }
    if (!current) {
      throw new Error(`TOML key/value appears before a table header: ${line}`);
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    current[key] = parseTomlValue(value);
  }

  return root;
}

function getOrCreateTable(root: TomlTable, dottedPath: string): TomlTable {
  const parts = dottedPath.split(".").map((part) => part.trim()).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    const next = cursor[part];
    if (next === undefined) {
      const table: TomlTable = {};
      cursor[part] = table;
      cursor = table;
      continue;
    }
    if (!isTable(next)) {
      throw new Error(`TOML path \"${dottedPath}\" conflicts with a non-table value.`);
    }
    cursor = next;
  }
  return cursor;
}

function getOrCreateArrayTable(root: TomlTable, dottedPath: string): TomlTable[] {
  const parts = dottedPath.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("TOML array table path is empty.");
  }

  const leaf = parts.pop();
  let cursor = root;
  for (const part of parts) {
    const next = cursor[part];
    if (next === undefined) {
      const table: TomlTable = {};
      cursor[part] = table;
      cursor = table;
      continue;
    }
    if (!isTable(next)) {
      throw new Error(`TOML path \"${dottedPath}\" conflicts with a non-table value.`);
    }
    cursor = next;
  }

  const existing = cursor[leaf!];
  if (existing === undefined) {
    const tables: TomlTable[] = [];
    cursor[leaf!] = tables;
    return tables;
  }
  if (!Array.isArray(existing) || existing.some((item) => !isTable(item))) {
    throw new Error(`TOML path \"${dottedPath}\" conflicts with a non-array-table value.`);
  }
  return existing;
}

function parseTomlValue(rawValue: string): TomlPrimitive {
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    const inner = rawValue.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return splitTomlArray(inner).map(parseTomlString);
  }
  return parseTomlString(rawValue);
}

function splitTomlArray(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let inString = false;
  let quote = "";

  for (const char of value) {
    if ((char === '"' || char === "'") && (!inString || char === quote)) {
      if (inString && char === quote) {
        inString = false;
        quote = "";
      } else if (!inString) {
        inString = true;
        quote = char;
      }
      current += char;
      continue;
    }

    if (char === "," && !inString) {
      items.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

function parseTomlString(rawValue: string): string {
  const trimmed = rawValue.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  throw new Error(`Unsupported TOML value: ${rawValue}`);
}

function stripTomlComment(line: string): string {
  let result = "";
  let inString = false;
  let quote = "";

  for (const char of line) {
    if ((char === '"' || char === "'") && (!inString || char === quote)) {
      if (inString && char === quote) {
        inString = false;
        quote = "";
      } else if (!inString) {
        inString = true;
        quote = char;
      }
      result += char;
      continue;
    }

    if (char === "#" && !inString) {
      break;
    }

    result += char;
  }

  return result;
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
