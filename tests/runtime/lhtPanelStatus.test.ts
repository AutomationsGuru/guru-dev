import { fromGateResults } from '../../src/runtime/lhtPanelStatus.js';

describe("lhtPanelStatus.fromGateResults", () => {
  it("should report zero gates and no remaining work for an empty result set", () => {
    expect(fromGateResults([])).toEqual({ gates: 0, failed: 0, remaining: 0 });
  });

  it("should report all gates passed with nothing remaining when every gate passes", () => {
    const status = fromGateResults([
      { name: "typecheck", status: "passed" },
      { name: "tests", status: "passed" },
      { name: "review", status: "passed" }
    ]);

    expect(status).toEqual({ gates: 3, failed: 0, remaining: 0 });
  });

  it("should count failed gates as failed and remaining when some gates fail", () => {
    const status = fromGateResults([
      { name: "typecheck", status: "passed" },
      { name: "tests", status: "failed" },
      { name: "review", status: "failed" }
    ]);

    expect(status).toEqual({ gates: 3, failed: 2, remaining: 2 });
  });

  it("should count non-passed gates as remaining without inflating the failed count", () => {
    const status = fromGateResults([
      { name: "typecheck", status: "passed" },
      { name: "tests", status: "failed" },
      { name: "operator-signoff", status: "pending" }
    ]);

    expect(status).toEqual({ gates: 3, failed: 1, remaining: 2 });
  });
});
