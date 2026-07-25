import { buildJob, type SleeptimeConsolidationJob } from '../../src/fleet/sleeptimeConsolidationJob.js';

describe("sleeptimeConsolidationJob", () => {
  it("builds a remember-consolidate queue descriptor with payload and schedule", () => {
    const runAt = new Date("2026-07-20T08:15:00.000Z");
    const job: SleeptimeConsolidationJob = buildJob("agent-7", runAt);

    expect(job).toEqual({
      type: "remember-consolidate",
      payload: {
        agentId: "agent-7"
      },
      schedule: {
        runAt: "2026-07-20T08:15:00.000Z"
      }
    });
  });

  it("rejects blank agent ids and invalid schedules", () => {
    expect(() => buildJob("   ", new Date("2026-07-20T08:15:00.000Z"))).toThrow(/agentId/i);
    expect(() => buildJob("agent-7", new Date(Number.NaN))).toThrow(/runAt/i);
  });
});
