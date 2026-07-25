import { describe, expect, it } from "vitest";

import {
  GatePolicyError,
  exportGateList,
  gatesFor,
  parsePolicy,
  type GatePolicyInput
} from '../../src/runtime/gatePolicyAsCode.js';
import { GatePolicySchema } from '../../src/runtime/gatePolicyAsCodeSchema.js';

const validPolicy = {
  version: 1,
  gates: [
    {
      id: "tests-green",
      kind: "command-exit-zero",
      params: { command: "npm test" }
    },
    {
      id: "required-files",
      kind: "files-exist",
      params: { paths: ["src/index.ts", "README.md"] }
    },
    {
      id: "operator-signoff",
      kind: "operator-approved",
      params: {}
    }
  ],
  taskTypes: {
    code: ["tests-green", "required-files"],
    release: ["tests-green", "operator-signoff"]
  }
} satisfies GatePolicyInput;

describe("gate policy as code", () => {
  it("loads and validates a policy object and JSON document", () => {
    const objectPolicy = parsePolicy(validPolicy);
    const textPolicy = parsePolicy(JSON.stringify(validPolicy));

    expect(GatePolicySchema.parse(validPolicy)).toEqual({
      version: 1,
      gates: validPolicy.gates,
      taskTypes: validPolicy.taskTypes
    });
    expect(textPolicy.gates).toEqual(objectPolicy.gates);
    expect(textPolicy.taskTypes).toEqual(objectPolicy.taskTypes);
    expect(objectPolicy.gatesFor("code")).toEqual(objectPolicy.gates.slice(0, 2));
  });

  it("exports the selected gates in the completion-gate shape", () => {
    const policy = parsePolicy(validPolicy);

    expect(exportGateList(policy, "release")).toEqual([
      validPolicy.gates[0],
      validPolicy.gates[2]
    ]);
    expect(gatesFor(policy, "release").map((gate) => gate.id)).toEqual([
      "tests-green",
      "operator-signoff"
    ]);
  });

  it("fails closed for an unknown task type", () => {
    const policy = parsePolicy(validPolicy);

    expect(() => gatesFor(policy, "unknown-task")).toThrowError(
      new GatePolicyError('Unknown task type "unknown-task" in gate policy.')
    );
  });

  it("fails closed when a task references an unknown gate id", () => {
    const policy = parsePolicy(validPolicy);

    expect(() => gatesFor({
      ...policy,
      taskTypes: { code: ["missing-gate"] }
    }, "code")).toThrowError(
      new GatePolicyError('Unknown gate id "missing-gate" for task type "code".')
    );
  });

  it("accepts a gate map and normalizes its keys to ids", () => {
    const policy = parsePolicy({
      version: 1,
      gates: {
        "tests-green": { kind: "command-exit-zero", params: { command: "npm test" } }
      },
      taskTypes: { code: ["tests-green"] }
    });

    expect(policy.gatesFor("code")).toEqual([
      { id: "tests-green", kind: "command-exit-zero", params: { command: "npm test" } }
    ]);
  });

  it("rejects malformed policy text", () => {
    expect(() => parsePolicy("not json")).toThrow(/Invalid gate policy document/iu);
  });
});
