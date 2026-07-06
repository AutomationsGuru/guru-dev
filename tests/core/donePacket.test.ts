import { createDonePacket, createToolResult, parseVerdict, serializeDonePacket } from "../../src/core/donePacket.js";
import type { DonePacketInput } from "../../src/core/types.js";

const validDonePacket = {
  verdict: "GREEN",
  objective: "Prove done packets serialize with required evidence.",
  changedFiles: [
    {
      path: "src/core/donePacket.ts",
      summary: "Added done-packet creation and serialization helpers."
    }
  ],
  verification: [
    {
      command: "npm test",
      result: "all tests passed",
      passed: true
    }
  ],
  review: [
    {
      reviewer: "CodeRabbit",
      status: "passed",
      summary: "no blocking findings"
    }
  ],
  risks: [],
  nextSteps: ["Continue with the next implementation-plan task."]
} satisfies DonePacketInput;

describe("parseVerdict", () => {
  it("should accept the three traffic-light verdicts", () => {
    expect(parseVerdict("GREEN")).toBe("GREEN");
    expect(parseVerdict("YELLOW")).toBe("YELLOW");
    expect(parseVerdict("RED")).toBe("RED");
  });

  it("should reject invalid verdicts", () => {
    expect(() => parseVerdict("BLUE")).toThrow("Invalid verdict");
  });
});

describe("createDonePacket", () => {
  it("should create a valid done packet with required evidence", () => {
    const packet = createDonePacket(validDonePacket);

    expect(packet.verdict).toBe("GREEN");
    expect(packet.changedFiles).toHaveLength(1);
    expect(packet.verification[0]).toMatchObject({ passed: true });
    expect(packet.review[0]).toMatchObject({ reviewer: "CodeRabbit", status: "passed" });
  });

  it("should reject done packets with invalid verdicts", () => {
    const invalidPacket = {
      ...validDonePacket,
      verdict: "BLUE"
    } as unknown as DonePacketInput;

    expect(() => createDonePacket(invalidPacket)).toThrow("Invalid done packet");
  });

  it("should serialize a done packet into the handoff format", () => {
    const serialized = serializeDonePacket(validDonePacket);

    expect(serialized).toContain("VERDICT: GREEN");
    expect(serialized).toContain("Changed files:");
    expect(serialized).toContain("- PASS npm test: all tests passed");
    expect(serialized).toContain("- CodeRabbit: passed — no blocking findings");
  });
});

describe("createToolResult", () => {
  it("should create a normalized tool result", () => {
    const result = createToolResult({
      status: "success",
      summary: "Read file successfully."
    });

    expect(result).toEqual({
      status: "success",
      summary: "Read file successfully.",
      artifacts: [],
      nextActions: []
    });
  });

  it("should reject tool results without the required status and summary", () => {
    expect(() => createToolResult({ status: "success" })).toThrow("Invalid tool result");
    expect(() => createToolResult({ summary: "Missing status." })).toThrow("Invalid tool result");
  });
});
