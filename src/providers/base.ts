/**
 * Base adapter and provider infrastructure exports.
 *
 * Re-exports AbstractProviderAdapter from adapters/base.ts per build plan location.
 * This barrel allows adapters to import from "../base.js" as expected.
 */

export { AbstractProviderAdapter } from "./adapters/base.js";
export type { ProviderAdapter, ProviderError, ProviderConfig } from "./types/provider.js";
