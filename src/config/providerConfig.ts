import type { ProviderAdapter } from '../providers/types/provider.js';
import { OpenAIAdapter } from '../providers/adapters/openai.js';
import { AnthropicAdapter } from '../providers/adapters/anthropic.js';
import { GoogleAdapter } from '../providers/adapters/google.js';
import fs from 'fs';
import path from 'path';

export type ProviderName = 'openai' | 'anthropic' | 'google';

/**
 * Provider configuration interface
 */
export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

/**
 * GuruHarness configuration - alias for ProviderConfig for backward compatibility
 */
export type GuruHarnessConfig = ProviderConfig;

/**
 * Default configuration values
 */
const DEFAULT_PROVIDER: ProviderName = 'openai';
const DEFAULT_MODEL = 'gpt-4o';

/**
 * Valid provider names for validation
 */
const VALID_PROVIDERS: ProviderName[] = ['openai', 'anthropic', 'google'];

/**
 * Provider factory: Creates the appropriate adapter for a given provider name
 */
export function createProvider(
  name: ProviderName,
  apiKey?: string,
  baseURL?: string
): ProviderAdapter {
  switch (name) {
    case 'openai':
      return new OpenAIAdapter(apiKey, baseURL);
    case 'anthropic':
      return new AnthropicAdapter(apiKey, baseURL);
    case 'google':
      return new GoogleAdapter(apiKey, baseURL);
    default:
      throw new Error(
        `Invalid provider: "${name}". Valid providers are: ${VALID_PROVIDERS.join(', ')}`
      );
  }
}

/**
 * Validates a provider name
 */
export function isValidProvider(name: string): name is ProviderName {
  return VALID_PROVIDERS.includes(name as ProviderName);
}

/**
 * Loads provider configuration from guruharness.config.json
 */
export function loadProviderConfig(configPath?: string): ProviderConfig {
  const defaultConfigPath = path.join(process.cwd(), 'guruharness.config.json');
  const resolvedPath = configPath || defaultConfigPath;

  // Start with defaults
  let config: ProviderConfig = {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
  };

  // Try to load from config file
  if (fs.existsSync(resolvedPath)) {
    try {
      const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      const parsedConfig = JSON.parse(fileContent);

      // Extract provider configuration if present
      if (parsedConfig.provider) {
        const providerName = parsedConfig.provider;

        if (!isValidProvider(providerName)) {
          throw new Error(
            `Invalid provider in config: "${providerName}". Valid providers are: ${VALID_PROVIDERS.join(', ')}`
          );
        }

        config.provider = providerName;
      }

      if (parsedConfig.model) {
        config.model = parsedConfig.model;
      }

      // Optional API key and baseURL from config
      if (parsedConfig.apiKey) {
        config.apiKey = parsedConfig.apiKey;
      }

      if (parsedConfig.baseURL) {
        config.baseURL = parsedConfig.baseURL;
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Failed to parse config file at ${resolvedPath}: ${error.message}`);
      }
      throw error;
    }
  }

  // Override with environment variables if present
  const envProvider = process.env.GURUHARNESS_PROVIDER;
  if (envProvider && isValidProvider(envProvider)) {
    config.provider = envProvider;
  }

  const envModel = process.env.GURUHARNESS_MODEL;
  if (envModel) {
    config.model = envModel;
  }

  const envApiKey = process.env.GURUHARNESS_API_KEY;
  if (envApiKey) {
    config.apiKey = envApiKey;
  }

  const envBaseURL = process.env.GURUHARNESS_BASE_URL;
  if (envBaseURL) {
    config.baseURL = envBaseURL;
  }

  return config;
}

/**
 * Gets the default provider configuration
 */
export function getDefaultProviderConfig(): ProviderConfig {
  return {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
  };
}
