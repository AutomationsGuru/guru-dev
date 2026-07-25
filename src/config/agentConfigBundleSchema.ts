import { z } from "zod";

/**
 * Agent config bundle (IDEA-F91, R-CD-CONFIG).
 *
 * A versionable, secrets-free contract that lives at `.guru/agent-config.json`.
 * It names how the operator wants models, providers, and rule files arranged
 * for a project — without ever carrying a credential value. Every credential
 * is a reference: an environment-variable NAME the runtime resolves at boot.
 *
 * Foundational Law 1 (owned runtime) and Law 3 (no leaked secrets) both bind
 * here: the bundle is plain JSON+zod, depends on no provider SDK, and rejects
 * embedded secret values structurally (see {@link rejectEmbeddedSecrets} and
 * the per-field env-name regexes). The bundle never edits the harness config
 * schema in {@link ./schema.ts}; it is a separate, optional project artifact.
 */

/** Environment-variable names are references only — a key VALUE never lives in the bundle. */
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Bundle schema version. Bump only on a breaking shape change to the bundle itself. */
export const AGENT_CONFIG_BUNDLE_VERSION = 1 as const;

/**
 * A named provider the operator wants on record for the project.
 *
 * `apiKeyEnvVar` and `connectionStringEnvVar` are NAMES of environment
 * variables — never the connection string or key itself. A self-hosted or
 * non-default endpoint may be named via `baseUrl` (HTTPS or localhost only,
 * matching the planner model contract in {@link ../model/schemas.ts}).
 */
export const AgentConfigProviderSchema = z
  .object({
    /** Stable handle other fields reference by name (e.g. a model's `provider`). */
    name: z.string().trim().min(1).max(64),
    /** Provider kind — kept open so newly ATTACHed providers register without a schema churn. */
    kind: z.string().trim().min(1).max(64),
    /** Optional HTTPS/localhost endpoint; never required to carry a secret. */
    baseUrl: z.string().trim().url().refine(allowsSecureRemoteUrl, {
      message: "baseUrl must use HTTPS except for localhost endpoints."
    }).optional(),
    /** NAME of the env var holding the API key. Never the key value. */
    apiKeyEnvVar: z.string().trim().regex(ENVIRONMENT_VARIABLE_NAME).optional(),
    /** NAME of the env var holding a connection string (e.g. postgres://). Never the value. */
    connectionStringEnvVar: z.string().trim().regex(ENVIRONMENT_VARIABLE_NAME).optional(),
    /** Free-form note for operators; must not be used to stash a secret. */
    notes: z.string().trim().max(280).optional()
  })
  .strict();
export type AgentConfigProvider = z.infer<typeof AgentConfigProviderSchema>;

/**
 * A model bound to a named surface role (e.g. `planner`, `critic`, `summarizer`).
 *
 * Roles are not a fixed enum: they are operator-named so the bundle can describe
 * whatever role surface the project actually uses. The `provider` must resolve
 * against a provider listed in `providers` (validated by a refine on the bundle).
 */
export const AgentConfigModelRoleSchema = z
  .object({
    /** Operator-named role this model serves (e.g. "planner", "critic"). */
    role: z.string().trim().min(1).max(64),
    /** Must match a `providers[].name` declared alongside it. */
    provider: z.string().trim().min(1).max(64),
    /** Concrete model id the provider serves (e.g. "gpt-5.6-sol"). */
    model: z.string().trim().min(1).max(128),
    /** NAME of an env var overriding the provider key for this role only. */
    apiKeyEnvVar: z.string().trim().regex(ENVIRONMENT_VARIABLE_NAME).optional(),
    /** Optional temperature pin; otherwise the provider/runtime default applies. */
    temperature: z.number().min(0).max(2).optional()
  })
  .strict();
export type AgentConfigModelRole = z.infer<typeof AgentConfigModelRoleSchema>;

/**
 * A rule/mandate file the project wants loaded (paths only; the files own their content).
 *
 * Paths are project-relative by default; absolute paths are allowed so a home
 * profile can reference shared mandate files. The bundle never inlines rule
 * text — it points at durable files the kernel already reads.
 */
export const AgentConfigRulesPathSchema = z
  .object({
    /** Stable label for the rule source (e.g. "yolo-constitution", "team-mandates"). */
    name: z.string().trim().min(1).max(64),
    /** Path to a rule/mandate file, project-relative or absolute. */
    path: z.string().trim().min(1).max(512),
    /** Soft ordering hint; higher loads later. Defaults to 0. */
    order: z.number().int().min(0).max(1000).default(0),
    /** If false, a missing file is a warning rather than a load error. */
    required: z.boolean().default(true)
  })
  .strict();
export type AgentConfigRulesPath = z.infer<typeof AgentConfigRulesPathSchema>;

/**
 * The full agent config bundle.
 *
 * Every field is optional with safe defaults so a minimal `{}` or a
 * version-only file is valid; the bundle describes intent, never runtime state.
 */
export const AgentConfigBundleSchema = z
  .object({
    version: z.literal(AGENT_CONFIG_BUNDLE_VERSION).default(AGENT_CONFIG_BUNDLE_VERSION),
    /** Human-readable project label; defaults to a neutral placeholder. */
    project: z.string().trim().min(1).max(120).default("unspecified-project"),
    /** Named providers the project wants on record. */
    providers: z.array(AgentConfigProviderSchema).default([]),
    /** Model bindings per surface role. */
    models: z.array(AgentConfigModelRoleSchema).default([]),
    /** Rule/mandate file paths to load. */
    rules: z.array(AgentConfigRulesPathSchema).default([])
  })
  .strict()
  // Every model role must name a provider that is declared in this same bundle.
  .refine(modelsReferenceKnownProviders, {
    message: "One or more models reference an unknown provider; every models[].provider must match a providers[].name.",
    path: ["models"]
  });
export type AgentConfigBundle = z.infer<typeof AgentConfigBundleSchema>;
export type AgentConfigBundleInput = z.input<typeof AgentConfigBundleSchema>;

/** A bundle with defaults filled in, ready to serialize back to disk. */
export const DEFAULT_AGENT_CONFIG_BUNDLE: AgentConfigBundle = AgentConfigBundleSchema.parse({});

function modelsReferenceKnownProviders(bundle: { providers: Array<{ name: string }>; models: Array<{ provider: string }> }): boolean {
  if (bundle.models.length === 0) {
    return true;
  }
  const known = new Set(bundle.providers.map((provider) => provider.name));
  return bundle.models.every((model) => known.has(model.provider));
}

function allowsSecureRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
