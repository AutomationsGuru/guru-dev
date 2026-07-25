import { createPrePostToolBridge } from '../../src/hooks/hooksPrePostToolBridge.js';

describe("hooksPrePostToolBridge", () => {
  it("invokes pre then tool then post in order and records call log", () => {
    const bridge = createPrePostToolBridge();
    const order: string[] = [];
    const payload = { toolId: "test-tool", input: { foo: "bar" } };
    const resultPayload = { toolId: "test-tool", output: { status: "succeeded" } };

    bridge.onPre((p) => {
      order.push("pre-cb");
      expect(p).toBe(payload);
    });
    bridge.onPost((r) => {
      order.push("post-cb");
      expect(r).toBe(resultPayload);
    });

    const actualResult = bridge.runTool(payload, (p) => {
      order.push("tool-impl");
      return resultPayload;
    });

    expect(actualResult).toBe(resultPayload);
    expect(order).toEqual(["pre-cb", "tool-impl", "post-cb"]);
    expect(bridge.callLog).toEqual(["pre", "tool", "post"]);
  });

  it("supports multiple pre and post callbacks while preserving order", () => {
    const bridge = createPrePostToolBridge();
    const log: string[] = [];
    const payload = { toolId: "multi", input: null };

    bridge.onPre(() => log.push("pre1"));
    bridge.onPre(() => log.push("pre2"));
    bridge.onPost(() => log.push("post1"));
    bridge.onPost(() => log.push("post2"));

    bridge.runTool(payload, () => ({ toolId: "multi", output: {} }));

    expect(log).toEqual(["pre1", "pre2", "post1", "post2"]);
  });
});
