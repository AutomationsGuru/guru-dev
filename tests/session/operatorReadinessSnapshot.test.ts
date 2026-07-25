import { toMarkdown, type OperatorReadinessSnapshot } from '../../src/session/operatorReadinessSnapshot.js';

describe("toMarkdown", () => {
  it("exports readiness, auth, skills, and pending flags", () => {
    const snapshot: OperatorReadinessSnapshot = {
      readiness: [{ id: "runtime", status: "ready", detail: "Local runtime is available." }],
      auth: [{ id: "openai", status: "connected", detail: "Environment credential is present." }],
      skills: [{ id: "memory", status: "ready", detail: "Markdown memory is loaded." }],
      pendingFlags: [{ id: "review", status: "pending", detail: "Review evidence is required." }]
    };

    const markdown = toMarkdown(snapshot);

    expect(markdown).toContain("# Operator readiness snapshot");
    expect(markdown).toContain("## Readiness");
    expect(markdown).toContain("runtime");
    expect(markdown).toContain("## Auth");
    expect(markdown).toContain("openai");
    expect(markdown).toContain("## Skills");
    expect(markdown).toContain("memory");
    expect(markdown).toContain("## Pending flags");
    expect(markdown).toContain("review");
  });

  it("renders each section and entry in a stable order", () => {
    const snapshot: OperatorReadinessSnapshot = {
      readiness: [
        { id: "zebra", status: "ready" },
        { id: "alpha", status: "ready" }
      ],
      auth: [],
      skills: [{ id: "zeta", status: "ready" }],
      pendingFlags: []
    };

    expect(toMarkdown(snapshot)).toBe(`# Operator readiness snapshot

## Readiness

| Id | Status | Detail |
| --- | --- | --- |
| alpha | ready |  |
| zebra | ready |  |

## Auth

None.

## Skills

| Id | Status | Detail |
| --- | --- | --- |
| zeta | ready |  |

## Pending flags

None.
`);
  });
});
