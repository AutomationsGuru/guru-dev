import { describe, expect, it } from "vitest";

import {
  createApprovalLedger,
  deserializeLedger,
  ledgerRecordingPolicy,
  loadLedger,
  saveLedger,
  serializeLedger
} from "../../src/selfbuild/approvalLedger.js";
import type { MandatePolicyFn } from "../../src/executor/selfBuildExecutor.js";

describe("approvalLedger (P7) — auditable mandate trace that survives restart", () => {
  it("records every decision via the wrapper without changing it", () => {
    const ledger = createApprovalLedger();
    const base: MandatePolicyFn = (toolId) =>
      toolId === "bash"
        ? { outcome: "escalate", reason: "hard edge (spend)", verbs: ["spend"] }
        : { outcome: "allow", reason: "read-only", verbs: [] };
    const wrapped = ledgerRecordingPolicy(base, ledger);

    expect(wrapped("bash", { command: "terraform apply" }, "/")?.outcome).toBe("escalate"); // unchanged
    wrapped("repo.context.resolve", {}, "/");

    expect(ledger.entries()).toHaveLength(2);
    expect(ledger.entries()[0]).toMatchObject({ toolId: "bash", outcome: "escalate", verbs: ["spend"] });
  });

  it("survives a restart: serialize → deserialize round-trips every entry", () => {
    const ledger = createApprovalLedger();
    ledger.record({ toolId: "bash", outcome: "escalate", verbs: ["spend"], reason: "hard edge" });
    const restored = deserializeLedger(serializeLedger(ledger)); // simulate a process restart
    expect(restored.entries()).toEqual(ledger.entries());
  });

  it("save/load through an injected store round-trips (the on-disk restart path)", () => {
    const store = new Map<string, string>();
    const ledger = createApprovalLedger([{ toolId: "x", outcome: "allow", verbs: [], reason: "" }]);
    saveLedger(ledger, "/tmp/ledger.json", (path, data) => {
      store.set(path, data);
    });
    const loaded = loadLedger("/tmp/ledger.json", (path) => store.get(path) ?? "");
    expect(loaded.entries()).toHaveLength(1);
    expect(loaded.entries()[0]?.toolId).toBe("x");
  });

  it("a missing/unreadable ledger file → an empty ledger (no crash)", () => {
    const loaded = loadLedger("/nope", () => {
      throw new Error("ENOENT");
    });
    expect(loaded.entries()).toEqual([]);
  });
});
