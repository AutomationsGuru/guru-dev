import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import {
  hardLimitSectionChecksum,
  validateSystemPromptSectionProposal
} from '../../src/memory/systemPromptLearningGuard.js';

const HARD_LIMITS = [
  "## Hard limits",
  "1. No destruction without preservation.",
  "2. No unapproved spend.",
  "3. No leaked secrets.",
  "4. No moral or out-of-scope crossing.",
  "5. No ungoverned self-improvement."
].join("\n");

const CURRENT_SECTION = ["You are GuruHarness.", "", HARD_LIMITS, "", "## Memory", "Use memory_get for bodies."].join("\n");

describe("system prompt learning guard", () => {
  it("accepts a rewrite that preserves the hard-limit section verbatim", () => {
    const proposed = [
      "You are GuruHarness, sharper today.",
      "",
      HARD_LIMITS,
      "",
      "## Memory",
      "Use memory_get for bodies; cite what you use."
    ].join("\n");

    const verdict = validateSystemPromptSectionProposal({
      currentSection: CURRENT_SECTION,
      proposedSection: proposed,
      hardLimitSection: HARD_LIMITS
    });

    expect(verdict).toMatchObject({ status: "accepted", hardLimitChecksum: hardLimitSectionChecksum(HARD_LIMITS) });
  });

  it("rejects a rewrite that strips the hard-limit section", () => {
    const proposed = ["You are GuruHarness, sharper today.", "", "## Memory", "Learned to be concise."].join("\n");

    const verdict = validateSystemPromptSectionProposal({
      currentSection: CURRENT_SECTION,
      proposedSection: proposed,
      hardLimitSection: HARD_LIMITS
    });

    expect(verdict.status).toBe("rejected");
    if (verdict.status !== "rejected") throw new Error("expected a rejected verdict");
    expect(verdict.blockers.join(" ")).toMatch(/strips or alters the hard-limit section/);
  });

  it("rejects a rewrite that edits any hard-limit line, even one word", () => {
    const weakened = HARD_LIMITS.replace("No unapproved spend.", "No unapproved spend unless busy.");
    const proposed = CURRENT_SECTION.replace(HARD_LIMITS, weakened);

    const verdict = validateSystemPromptSectionProposal({
      currentSection: CURRENT_SECTION,
      proposedSection: proposed,
      hardLimitSection: HARD_LIMITS
    });

    expect(verdict.status).toBe("rejected");
  });

  it("rejects when the current section does not match the baseline hard-limit section", () => {
    const verdict = validateSystemPromptSectionProposal({
      currentSection: "You are GuruHarness with no limits recorded.",
      proposedSection: CURRENT_SECTION,
      hardLimitSection: HARD_LIMITS
    });

    expect(verdict.status).toBe("rejected");
    if (verdict.status !== "rejected") throw new Error("expected a rejected verdict");
    expect(verdict.blockers.join(" ")).toMatch(/unknown baseline/);
  });

  it("tolerates CRLF and trailing-whitespace formatting differences in the proposal", () => {
    const proposed = CURRENT_SECTION.replace(/\n/g, "\r\n") + "  \n";

    const verdict = validateSystemPromptSectionProposal({
      currentSection: CURRENT_SECTION,
      proposedSection: proposed,
      hardLimitSection: HARD_LIMITS
    });

    expect(verdict.status).toBe("accepted");
  });

  it("exposes a stable sha256 checksum of the protected section", () => {
    const normalized = HARD_LIMITS.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
    const expected = createHash("sha256").update(normalized).digest("hex");

    expect(hardLimitSectionChecksum(HARD_LIMITS)).toBe(expected);
    expect(hardLimitSectionChecksum(`\n${HARD_LIMITS}\r\n`)).toBe(expected);
    expect(hardLimitSectionChecksum(`${HARD_LIMITS} edited`)).not.toBe(expected);
  });
});
