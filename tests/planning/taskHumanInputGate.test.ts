import { canComplete } from '../../src/planning/taskHumanInputGate.js';

describe("canComplete", () => {
  it("blocks a human-input task without an operator receipt", () => {
    expect(canComplete({ humanInput: true })).toBe(false);
  });

  it("allows a human-input task after an operator receipt", () => {
    expect(canComplete({ humanInput: true }, { receivedAt: "2026-07-20T20:00:00.000Z" })).toBe(true);
  });

  it("allows tasks that do not require human input", () => {
    expect(canComplete({ humanInput: false })).toBe(true);
  });
});
