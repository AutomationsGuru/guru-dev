/*
 * Simple trust gate for MCP project-configured servers.
 *
 * Rule: do not allow connecting to a server unless the project explicitly
 * marks it as trusted. The gate is a pure predicate `mayConnect(trusted, source)`
 * where `trusted` is an array of allowed server ids and `source` is the server
 * config to test.
 *
 * This file is owned by IDEA-F217-MCP-TRUST-01 per the build plan. It must be
 * small, testable, and free of side-effects. No attach/connect logic lives
 * here — callers call `mayConnect` before attempting any connection.
 */

import type { McpServerConfig } from "./schemas.js";

export function mayConnect(trusted: readonly string[] | undefined, source: McpServerConfig): boolean {
  // If the project has no trust list at all, be conservative: deny.
  if (!trusted || trusted.length === 0) return false;

  // Only exact id matches are allowed. Trust list entries are lowercased
  // slugs by schema; server ids are validated upstream but normalize anyway.
  const target = String(source.id).trim().toLowerCase();
  return trusted.some((t) => String(t).trim().toLowerCase() === target);
}
