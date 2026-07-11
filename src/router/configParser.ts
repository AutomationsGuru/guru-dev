import {
  LITELLM_BASELINE_ALIASES,
  LITELLM_PROVIDER_GROUPS,
  LiteLlmAliasSchema,
  LiteLlmConfigManifestSchema,
  LiteLlmProviderGroupSchema,
  type LiteLlmAlias,
  type LiteLlmBaselineValidation,
  type LiteLlmConfigManifest,
  type LiteLlmProviderGroup
} from "./schemas.js";

interface RawLiteLlmEntry {
  readonly modelName: string;
  readonly litellmParams: Record<string, string>;
  readonly metadata: Record<string, unknown>;
}

export interface ParseLiteLlmConfigOptions {
  readonly expectedAliases?: readonly string[];
  readonly expectedProviderGroups?: readonly LiteLlmProviderGroup[];
}

export function parseLiteLlmConfigYaml(yamlText: string, options: ParseLiteLlmConfigOptions = {}): LiteLlmConfigManifest {
  const entries = parseModelListEntries(yamlText);
  const aliases = entries.map(aliasFromEntry);
  const baseline = validateLiteLlmBaseline(aliases, options);
  const providerGroups = unique(aliases.map((alias) => alias.providerGroup)).sort();
  const routerAliases = unique(aliases.flatMap((alias) => alias.metadata.router_aliases.length > 0 ? alias.metadata.router_aliases : [alias.alias])).sort();

  return LiteLlmConfigManifestSchema.parse({
    aliases: aliases.sort((left, right) => left.alias.localeCompare(right.alias)),
    providerGroups,
    metadata: { router_aliases: routerAliases },
    baseline
  });
}

export function validateLiteLlmBaseline(aliases: readonly LiteLlmAlias[], options: ParseLiteLlmConfigOptions = {}): LiteLlmBaselineValidation {
  const expectedAliases = [...(options.expectedAliases ?? LITELLM_BASELINE_ALIASES)].sort();
  const expectedProviderGroups = [...(options.expectedProviderGroups ?? LITELLM_PROVIDER_GROUPS)].sort();
  const actualAliases = unique(aliases.map((alias) => alias.alias)).sort();
  const actualGroups = unique(aliases.map((alias) => alias.providerGroup)).sort();
  const missingAliases = expectedAliases.filter((alias) => !actualAliases.includes(alias));
  const extraAliases = actualAliases.filter((alias) => !expectedAliases.includes(alias));
  const missingProviderGroups = expectedProviderGroups.filter((group) => !actualGroups.includes(group));
  const extraProviderGroups = actualGroups.filter((group) => !expectedProviderGroups.includes(group));
  const verdict = missingAliases.length === 0 && extraAliases.length === 0 && missingProviderGroups.length === 0 && extraProviderGroups.length === 0 ? "GREEN" : missingAliases.length === 0 && missingProviderGroups.length === 0 ? "YELLOW" : "RED";

  return {
    expectedAliasCount: expectedAliases.length,
    expectedProviderGroupCount: expectedProviderGroups.length,
    aliasCount: actualAliases.length,
    providerGroupCount: actualGroups.length,
    missingAliases,
    extraAliases,
    missingProviderGroups: missingProviderGroups.map((group) => LiteLlmProviderGroupSchema.parse(group)),
    extraProviderGroups,
    verdict
  };
}

function parseModelListEntries(yamlText: string): readonly RawLiteLlmEntry[] {
  const entries: RawLiteLlmEntry[] = [];
  let inModelList = false;
  let current: MutableRawEntry | undefined;
  let section: "litellm_params" | "metadata" | undefined;
  let metadataListKey: string | undefined;

  for (const rawLine of yamlText.split(/\r?\n/u)) {
    const withoutComment = stripYamlComment(rawLine);
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = countIndent(withoutComment);
    const line = withoutComment.trim();

    if (indent === 0 && line === "model_list:") {
      inModelList = true;
      continue;
    }

    if (!inModelList) {
      continue;
    }

    if (indent === 0 && !line.startsWith("-")) {
      inModelList = false;
      continue;
    }

    if (indent === 2 && line.startsWith("- ")) {
      if (current) {
        entries.push(freezeEntry(current));
      }
      current = { modelName: "", litellmParams: {}, metadata: {} };
      section = undefined;
      metadataListKey = undefined;
      const rest = line.slice(2).trim();
      if (rest.length > 0) {
        const parsed = parseKeyValue(rest);
        if (parsed?.key === "model_name") {
          current.modelName = parsed.value;
        }
      }
      continue;
    }

    if (!current) {
      continue;
    }

    if (indent === 4 && line.endsWith(":")) {
      const key = line.slice(0, -1);
      if (key === "litellm_params") {
        section = "litellm_params";
        metadataListKey = undefined;
      } else if (key === "model_info") {
        section = undefined;
        metadataListKey = undefined;
      } else {
        section = undefined;
        metadataListKey = undefined;
      }
      continue;
    }

    if (indent === 4) {
      const parsed = parseKeyValue(line);
      if (parsed?.key === "model_name") {
        current.modelName = parsed.value;
      }
      continue;
    }

    if (indent === 6 && line === "metadata:") {
      section = "metadata";
      metadataListKey = undefined;
      continue;
    }

    if (indent === 6 && section === "litellm_params") {
      const parsed = parseKeyValue(line);
      if (parsed) {
        current.litellmParams[parsed.key] = parsed.value;
      }
      continue;
    }

    if (indent === 8 && section === "metadata") {
      if (line.endsWith(":")) {
        metadataListKey = line.slice(0, -1);
        current.metadata[metadataListKey] = [];
        continue;
      }

      const parsed = parseKeyValue(line);
      if (parsed) {
        current.metadata[parsed.key] = parsed.value;
        metadataListKey = undefined;
      }
      continue;
    }

    if (indent === 10 && section === "metadata" && metadataListKey && line.startsWith("- ")) {
      const existing = current.metadata[metadataListKey];
      const values = Array.isArray(existing) ? existing : [];
      values.push(parseScalar(line.slice(2).trim()));
      current.metadata[metadataListKey] = values;
    }
  }

  if (current) {
    entries.push(freezeEntry(current));
  }

  const duplicates = findDuplicates(entries.map((entry) => entry.modelName));
  if (duplicates.length > 0) {
    throw new Error(`Duplicate LiteLLM aliases in config: ${duplicates.join(", ")}`);
  }

  return entries;
}

function aliasFromEntry(entry: RawLiteLlmEntry): LiteLlmAlias {
  if (!entry.modelName) {
    throw new Error("LiteLLM model_list entry is missing model_name.");
  }

  const model = entry.litellmParams.model;
  if (!model) {
    throw new Error(`LiteLLM alias ${entry.modelName} is missing litellm_params.model.`);
  }

  const rawProviderGroup = typeof entry.metadata.provider_group === "string" ? entry.metadata.provider_group : inferProviderGroup(entry.modelName);
  const providerGroup = LiteLlmProviderGroupSchema.parse(rawProviderGroup);
  const routerAliases = Array.isArray(entry.metadata.router_aliases) ? entry.metadata.router_aliases.filter((value): value is string => typeof value === "string") : [];
  const apiBase = entry.litellmParams.api_base;

  return LiteLlmAliasSchema.parse({
    alias: entry.modelName,
    providerGroup,
    provider: inferProvider(model),
    model,
    ...(apiBase && extractEnvVarNames(apiBase).length === 0 ? { apiBase } : {}),
    apiBaseEnvVarNames: apiBase ? extractEnvVarNames(apiBase) : [],
    credentialEnvVarNames: unique(Object.entries(entry.litellmParams).flatMap(([key, value]) => (key === "api_base" ? [] : extractEnvVarNames(value)))).sort(),
    litellmParams: entry.litellmParams,
    metadata: { ...entry.metadata, router_aliases: routerAliases }
  });
}

function inferProvider(model: string): string | undefined {
  const separatorIndex = model.indexOf("/");
  return separatorIndex > 0 ? model.slice(0, separatorIndex) : undefined;
}

function inferProviderGroup(alias: string): LiteLlmProviderGroup {
  if (alias.startsWith("router-openai-")) return "openai-platform";
  if (alias.startsWith("router-claude-")) return "anthropic-api";
  if (alias.startsWith("router-gemini-")) return "gemini-ai-studio";
  if (alias.startsWith("router-foundry-") || alias === "router-kimi" || alias.startsWith("router-deepseek") || alias === "router-grok") return "azure-foundry";
  if (alias.startsWith("router-glm-")) return "bigmodel-zhipu";
  if (alias.startsWith("router-minimax-")) return "minimax";
  if (alias.startsWith("router-fugu")) return "sakana";
  if (alias.startsWith("router-xai-")) return "xai-api";
  if (alias.startsWith("router-perplexity-")) return "perplexity-sonar";
  if (alias === "router-sonnet" || alias === "router-haiku" || alias === "router-opus") return "legacy-compatibility";
  if (alias.startsWith("router-vertex-claude-")) return "vertex-claude";
  throw new Error(`Unable to infer LiteLLM provider group for alias: ${alias}`);
}

function extractEnvVarNames(value: string): readonly string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(/os\.environ\/([A-Z][A-Z0-9_]*)/gu)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of value.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/gu)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of value.matchAll(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/gu)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

interface MutableRawEntry {
  modelName: string;
  litellmParams: Record<string, string>;
  metadata: Record<string, unknown>;
}

function freezeEntry(entry: MutableRawEntry): RawLiteLlmEntry {
  return {
    modelName: entry.modelName,
    litellmParams: { ...entry.litellmParams },
    metadata: { ...entry.metadata }
  };
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    if (char === '"' && !inSingle) inDouble = !inDouble;
    if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function countIndent(line: string): number {
  const match = /^( *)/u.exec(line);
  return match?.[1]?.length ?? 0;
}

function parseKeyValue(line: string): { readonly key: string; readonly value: string } | undefined {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex < 0) return undefined;
  return {
    key: line.slice(0, separatorIndex).trim(),
    value: parseScalar(line.slice(separatorIndex + 1).trim())
  };
}

function parseScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}
