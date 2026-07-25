import { describe, expect, it } from "vitest";

import { partition } from '../../src/tools/parallelToolBatch.js';

interface ToolCall {
  readonly id: string;
  readonly target: string;
}

const calls: readonly ToolCall[] = [
  { id: "read-package", target: "package.json" },
  { id: "read-config", target: "guruharness.config.json" },
  { id: "read-readme", target: "README.md" }
];

describe("partition", () => {
  it("groups independently executable calls into one parallel batch", () => {
    const batches = partition(calls, { independent: () => true });

    expect(batches).toEqual([calls]);
    expect(batches[0]).toHaveLength(3);
  });

  it("serializes calls that write the same target", () => {
    const writes: readonly ToolCall[] = [
      { id: "edit-one", target: "src/guru.ts" },
      { id: "edit-two", target: "src/guru.ts" }
    ];
    const batches = partition(writes, { independent: (left, right) => left.target !== right.target });

    expect(batches).toEqual([[writes[0]], [writes[1]]]);
  });
});
