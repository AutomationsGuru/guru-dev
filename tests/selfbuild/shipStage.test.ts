import { describe, expect, it, vi } from "vitest";

import { ChangeRecordSchema, runShipStage, type ShipStageResult } from "../../src/selfbuild/shipStage.js";

const payload = ChangeRecordSchema.parse({ taskId: "wire the ship stage", summary: "s", stages: [] });

describe("runShipStage (P5) — deliver without assuming any tool exists", () => {
  it("git absent → durable on-disk change-record (YELLOW, never RED-by-absence)", async () => {
    const writes: Array<{ path: string }> = [];
    const result = await runShipStage({
      cwd: "/repo",
      payload,
      commandExists: () => false, // no git, no gh
      writeChangeRecord: (_r, path) => {
        writes.push({ path });
      }
    });
    expect(result.target).toBe("local-record");
    expect(result.verdict).toBe("YELLOW");
    expect(result.evidence).toMatch(/git absent/u);
    expect(writes).toHaveLength(1);
    // path is slugified from the taskId
    expect(result.recordPath).toMatch(/wire-the-ship-stage\.json$/u);
  });

  it("git present + delivery wired → git path (commit/push); no local record written", async () => {
    const writeChangeRecord = vi.fn();
    const gitDelivery = vi.fn(async (): Promise<ShipStageResult> => ({ verdict: "GREEN", target: "git+pr", evidence: "pushed + PR opened" }));
    const result = await runShipStage({
      cwd: "/repo",
      payload,
      commandExists: () => true, // git + gh present
      gitDelivery,
      writeChangeRecord
    });
    expect(result.target).toBe("git+pr");
    expect(result.verdict).toBe("GREEN");
    expect(gitDelivery).toHaveBeenCalledWith({ gitPresent: true, ghPresent: true });
    expect(writeChangeRecord).not.toHaveBeenCalled();
  });

  it("git present, gh absent → delivery told ghPresent:false (commit/push, no PR)", async () => {
    const gitDelivery = vi.fn(async (): Promise<ShipStageResult> => ({ verdict: "GREEN", target: "git", evidence: "pushed, no PR" }));
    await runShipStage({
      cwd: "/repo",
      payload,
      commandExists: (name) => name === "git", // git yes, gh no
      gitDelivery
    });
    expect(gitDelivery).toHaveBeenCalledWith({ gitPresent: true, ghPresent: false });
  });

  it("git present but NO delivery wired → degrades to a local record (not a crash)", async () => {
    const result = await runShipStage({
      cwd: "/repo",
      payload,
      commandExists: () => true,
      writeChangeRecord: () => undefined
    });
    expect(result.target).toBe("local-record");
    expect(result.evidence).toMatch(/no delivery wired/u);
  });
});
