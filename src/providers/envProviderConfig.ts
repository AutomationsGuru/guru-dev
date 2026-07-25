export interface EnvProviderConfig {
  readonly providerId: string;
  readonly modelId: string;
}

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/u;
const MODEL_ID = /^[a-zA-Z0-9._/-]+$/u;

/** Parses comma-separated `provider:model` entries from an environment string. */
export function parseEnvProviders(raw: string | undefined): readonly EnvProviderConfig[] {
  if (!raw) return [];

  return raw.split(",").flatMap((entry) => {
    const [providerId, modelId, ...extra] = entry.trim().split(":");
    if (!providerId || !modelId || extra.length > 0 || !PROVIDER_ID.test(providerId) || !MODEL_ID.test(modelId)) return [];
    return [{ providerId, modelId }];
  });
}
