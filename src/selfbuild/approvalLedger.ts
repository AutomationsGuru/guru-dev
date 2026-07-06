import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import type { MandatePolicyFn } from "../executor/selfBuildExecutor.js";

/**
 * Approval ledger (self-build P7 / THERE acceptance) — every mandate decision an
 * autonomous run makes (allow / deny / escalate, with the verbs + reason) is recorded, and
 * the ledger serialises to disk so it SURVIVES A RESTART. A `ledgerRecordingPolicy` wraps
 * any mandate policy to capture decisions without changing them, so the spend/hard-edge gate
 * stays authoritative and every call it evaluates leaves an auditable trace.
 */

export const LedgerEntrySchema = z
  .object({
    toolId: z.string(),
    outcome: z.enum(["allow", "deny", "escalate"]),
    verbs: z.array(z.string()).default([]),
    reason: z.string().default("")
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

const LedgerFileSchema = z.object({ entries: z.array(LedgerEntrySchema).default([]) }).strict();

export interface ApprovalLedger {
  record(entry: LedgerEntry): void;
  entries(): readonly LedgerEntry[];
}

export function createApprovalLedger(seed: readonly LedgerEntry[] = []): ApprovalLedger {
  const list: LedgerEntry[] = [...seed];
  return {
    record: (entry) => {
      list.push(LedgerEntrySchema.parse(entry));
    },
    entries: () => [...list]
  };
}

/** Wrap a mandate policy so every decision it returns is recorded — decisions are unchanged. */
export function ledgerRecordingPolicy(policy: MandatePolicyFn, ledger: ApprovalLedger): MandatePolicyFn {
  return (toolId, input, cwd) => {
    const decision = policy(toolId, input, cwd);
    if (decision) {
      ledger.record({ toolId, outcome: decision.outcome, verbs: [...decision.verbs], reason: decision.reason });
    }
    return decision;
  };
}

export function serializeLedger(ledger: ApprovalLedger): string {
  return `${JSON.stringify({ entries: ledger.entries() }, null, 2)}\n`;
}

export function deserializeLedger(json: string): ApprovalLedger {
  const parsed = LedgerFileSchema.parse(JSON.parse(json));
  return createApprovalLedger(parsed.entries);
}

export function saveLedger(ledger: ApprovalLedger, path: string, writeFile?: (path: string, data: string) => void): void {
  if (writeFile) {
    writeFile(path, serializeLedger(ledger));
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeLedger(ledger), "utf8");
}

/** Load a ledger from disk — the "survives restart" path. Missing/unreadable → an empty ledger. */
export function loadLedger(path: string, readFile?: (path: string) => string): ApprovalLedger {
  try {
    const raw = readFile ? readFile(path) : readFileSync(path, "utf8");
    return deserializeLedger(raw);
  } catch {
    return createApprovalLedger();
  }
}
