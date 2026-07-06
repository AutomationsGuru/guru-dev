import {
  DonePacketSchema,
  ToolResultSchema,
  VerdictSchema,
  type DonePacket,
  type DonePacketInput,
  type ToolResult,
  type Verdict
} from "./types.js";

export function parseVerdict(value: unknown): Verdict {
  const result = VerdictSchema.safeParse(value);

  if (!result.success) {
    throw new Error(`Invalid verdict: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  return result.data;
}

export function createDonePacket(input: DonePacketInput): DonePacket {
  const result = DonePacketSchema.safeParse(input);

  if (!result.success) {
    throw new Error(`Invalid done packet: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  return result.data;
}

export function createToolResult(input: unknown): ToolResult {
  const result = ToolResultSchema.safeParse(input);

  if (!result.success) {
    throw new Error(`Invalid tool result: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  return result.data;
}

export function serializeDonePacket(input: DonePacketInput): string {
  const packet = createDonePacket(input);

  return [
    `VERDICT: ${packet.verdict}`,
    "",
    "Objective:",
    `- ${packet.objective}`,
    "",
    "Changed files:",
    ...formatChangedFiles(packet),
    "",
    "Verification:",
    ...formatVerification(packet),
    "",
    "Review:",
    ...formatReview(packet),
    "",
    "Risks / notes:",
    ...formatList(packet.risks),
    "",
    "Next steps:",
    ...formatList(packet.nextSteps)
  ].join("\n");
}

function formatChangedFiles(packet: DonePacket): string[] {
  if (packet.changedFiles.length === 0) {
    return ["- none"];
  }

  return packet.changedFiles.map((file) => `- ${file.path}: ${file.summary}`);
}

function formatVerification(packet: DonePacket): string[] {
  if (packet.verification.length === 0) {
    return ["- none"];
  }

  return packet.verification.map((evidence) => {
    const status = evidence.passed ? "PASS" : "FAIL";
    return `- ${status} ${evidence.command}: ${evidence.result}`;
  });
}

function formatReview(packet: DonePacket): string[] {
  if (packet.review.length === 0) {
    return ["- none"];
  }

  return packet.review.map((evidence) => `- ${evidence.reviewer}: ${evidence.status} — ${evidence.summary}`);
}

function formatList(items: readonly string[]): string[] {
  if (items.length === 0) {
    return ["- none"];
  }

  return items.map((item) => `- ${item}`);
}
