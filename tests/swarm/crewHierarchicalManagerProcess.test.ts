import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  CrewProcessOptionsSchema,
  CrewProcessSchema,
  validateProcess
} from '../../src/swarm/crewHierarchicalManagerProcess.js';

// ---------------------------------------------------------------------------
// R-CR-HIER: Process hierarchical requires manager agent id; sequential does
// not. This file follows RED→GREEN TDD for the plan step:
//   "Tests: hierarchical without manager fails."
// ---------------------------------------------------------------------------

describe("CrewProcessSchema — enum guards", () => {
  it("accepts 'sequential'", () => {
    expect(CrewProcessSchema.parse("sequential")).toBe("sequential");
  });

  it("accepts 'hierarchical'", () => {
    expect(CrewProcessSchema.parse("hierarchical")).toBe("hierarchical");
  });

  it("rejects unknown process values", () => {
    expect(() => CrewProcessSchema.parse("parallel")).toThrow(ZodError);
    expect(() => CrewProcessSchema.parse("")).toThrow(ZodError);
    expect(() => CrewProcessSchema.parse(null)).toThrow(ZodError);
  });
});

describe("CrewProcessOptionsSchema — process=hierarchical requires managerId; sequential does not", () => {
  it("R-CR-HIER: hierarchical without managerId FAILS", () => {
    // This is the direct test of the requirement. A crew configured as
    // hierarchical MUST name the manager agent — without one there is no
    // delegation authority.
    expect(() =>
      CrewProcessOptionsSchema.parse({ process: "hierarchical" })
    ).toThrow(ZodError);
  });

  it("R-CR-HIER: hierarchical with managerId passes", () => {
    const opts = CrewProcessOptionsSchema.parse({
      process: "hierarchical",
      managerId: "agent-orchestrator-1"
    });
    expect(opts.process).toBe("hierarchical");
    expect(opts.managerId).toBe("agent-orchestrator-1");
  });

  it("hierarchical rejects empty-string managerId", () => {
    expect(() =>
      CrewProcessOptionsSchema.parse({
        process: "hierarchical",
        managerId: ""
      })
    ).toThrow(ZodError);
    expect(() =>
      CrewProcessOptionsSchema.parse({
        process: "hierarchical",
        managerId: "   "
      })
    ).toThrow(ZodError);
  });

  it("sequential without managerId passes (not required)", () => {
    const opts = CrewProcessOptionsSchema.parse({ process: "sequential" });
    expect(opts.process).toBe("sequential");
    expect(opts.managerId).toBeUndefined();
  });

  it("sequential with managerId passes (allowed, just unused)", () => {
    const opts = CrewProcessOptionsSchema.parse({
      process: "sequential",
      managerId: "agent-42"
    });
    expect(opts.process).toBe("sequential");
    expect(opts.managerId).toBe("agent-42");
  });

  it("rejects extra unknown keys (strict)", () => {
    expect(() =>
      CrewProcessOptionsSchema.parse({
        process: "hierarchical",
        managerId: "mgr",
        unsupported: true
      })
    ).toThrow(ZodError);

    expect(() =>
      CrewProcessOptionsSchema.parse({
        process: "sequential",
        extraField: 123
      })
    ).toThrow(ZodError);
  });

  it("rejects non-object input", () => {
    expect(() => CrewProcessOptionsSchema.parse(null)).toThrow(ZodError);
    expect(() => CrewProcessOptionsSchema.parse("hierarchical")).toThrow(ZodError);
    expect(() => CrewProcessOptionsSchema.parse(undefined)).toThrow(ZodError);
    expect(() => CrewProcessOptionsSchema.parse([])).toThrow(ZodError);
  });
});

describe("validateProcess — thin parse wrapper", () => {
  it("returns parsed options for valid hierarchical", () => {
    const result = validateProcess({
      process: "hierarchical",
      managerId: "lead-agent"
    });
    expect(result).toEqual({ process: "hierarchical", managerId: "lead-agent" });
  });

  it("returns parsed options for valid sequential", () => {
    const result = validateProcess({ process: "sequential" });
    expect(result).toEqual({ process: "sequential" });
  });

  it("throws ZodError for hierarchical without managerId", () => {
    expect(() =>
      validateProcess({ process: "hierarchical" })
    ).toThrow(ZodError);
  });

  it("throws ZodError for unknown process", () => {
    expect(() =>
      validateProcess({ process: "invalid" })
    ).toThrow(ZodError);
  });
});
