import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { type Verdict } from "../core/types.js";
import type { HonchoClient } from "../honcho/client.js";
import { getProviderCliStatusMatrix, type ProviderCliStatusOptions } from "../provider-cli/status.js";
import { ReadinessReportSchema, type ReadinessReport, type ReadinessRow, type ValidationCheckRow } from "./schemas.js";

/**
 * Trimmed readiness report folded from integration-tools. Covers the runtime,
 * Honcho, provider-CLI, and validation rows — the surfaces that exist in main today.
 * MCP / desktop / local-service rows are intentionally omitted until those modules
 * are folded in (Goal 4 excludes MCP/desktop). No secret values are ever emitted.
 */
export interface ReadinessReportOptions {
  readonly runtimeName?: string;
  readonly honchoClient?: HonchoClient;
  readonly providerCli?: ProviderCliStatusOptions;
  readonly validationChecks?: readonly ValidationCheckRow[];
  readonly extraRows?: readonly ReadinessRow[];
  readonly now?: () => Date;
}

export async function buildReadinessReport(options: ReadinessReportOptions = {}): Promise<ReadinessReport> {
  const rows: ReadinessRow[] = [];

  rows.push(
    row({
      id: "runtime:guruharness",
      category: "runtime",
      title: "GuruHarness runtime",
      status: "ready",
      verdict: "GREEN",
      ownerModule: "src/readiness",
      evidence: runtimeVersion() ? [runtimeVersion() as string] : [],
      summary: "GuruHarness runtime package is readable."
    })
  );

  if (options.honchoClient) {
    const status = options.honchoClient.status();
    rows.push(
      row({
        id: "honcho",
        category: "honcho",
        title: "Honcho memory",
        status: toReadinessStatus(status.status),
        verdict: status.status === "ready" || status.status === "read-only" ? "GREEN" : "YELLOW",
        ownerModule: "src/honcho",
        missingEnvNames: status.missingEnvNames,
        summary: status.summary
      })
    );
  } else {
    rows.push(
      row({
        id: "honcho",
        category: "honcho",
        title: "Honcho memory",
        status: "not-implemented",
        verdict: "YELLOW",
        ownerModule: "src/honcho",
        summary: "No Honcho client was provided; adapter contract is available but runtime wiring is pending."
      })
    );
  }

  for (const cli of await getProviderCliStatusMatrix(options.providerCli)) {
    rows.push(
      row({
        id: `provider-cli:${cli.id}`,
        category: "provider-cli",
        title: `Provider CLI ${cli.id}`,
        status: toReadinessStatus(cli.status),
        verdict: cli.status === "ready" ? "GREEN" : cli.status === "missing-command" || cli.status === "missing-env" ? "YELLOW" : "RED",
        ownerModule: "src/provider-cli",
        missingEnvNames: cli.missingEnvNames,
        evidence: cli.version ? [cli.version] : [],
        summary: cli.summary
      })
    );
  }

  rows.push(...(options.extraRows ?? []));

  for (const check of options.validationChecks ?? []) {
    rows.push(
      row({
        id: `validation:${check.name}`,
        category: "validation",
        title: `Validation ${check.name}`,
        status: check.status === "passed" ? "ready" : check.status === "not-run" ? "ready-unverified" : "failing",
        verdict: check.status === "passed" ? "GREEN" : check.status === "not-run" ? "YELLOW" : "RED",
        ownerModule: "src/readiness",
        evidence: [`${check.command.join(" ")} -> ${check.status}`],
        summary: check.summary
      })
    );
  }

  const verdict = deriveVerdict(rows);

  return ReadinessReportSchema.parse({
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    runtimeName: options.runtimeName ?? "GuruHarness",
    runtimeVersion: runtimeVersion(),
    verdict,
    rows,
    validationChecks: options.validationChecks ?? [],
    summary: `${verdict}: ${rows.filter((candidate) => candidate.verdict === "GREEN").length}/${rows.length} readiness row(s) are GREEN.`
  });
}

function row(input: Omit<ReadinessRow, "missingEnvNames" | "evidence"> & Partial<Pick<ReadinessRow, "missingEnvNames" | "evidence">>): ReadinessRow {
  return { ...input, missingEnvNames: input.missingEnvNames ?? [], evidence: input.evidence ?? [] };
}

function toReadinessStatus(status: string): ReadinessRow["status"] {
  switch (status) {
    case "ready":
    case "read-only":
      return "ready";
    case "missing-env":
      return "missing-env";
    case "missing-command":
      return "missing-command";
    case "offline":
      return "offline";
    case "disabled":
      return "blocked";
    case "error":
    case "failing":
      return "failing";
    default:
      return "not-implemented";
  }
}

function deriveVerdict(rows: readonly ReadinessRow[]): Verdict {
  if (rows.some((candidate) => candidate.verdict === "RED")) {
    return "RED";
  }

  if (rows.some((candidate) => candidate.verdict === "YELLOW")) {
    return "YELLOW";
  }

  return "GREEN";
}

function runtimeVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { readonly version?: string };

    return pkg.version;
  } catch {
    return existsSync("package.json") ? "unknown" : undefined;
  }
}
