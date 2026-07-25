import {
  formatReceipt,
  runSelfCheckPass
} from '../../src/review/selfCheckPass.js';
import {
  SelfCheckPassConfigSchema,
  DEFAULT_SELF_CHECK_CONFIG,
  type SelfCheckPassConfig
} from '../../src/review/selfCheckSchema.js';

const enabled = (overrides: Partial<SelfCheckPassConfig> = {}): SelfCheckPassConfig =>
  SelfCheckPassConfigSchema.parse({ ...DEFAULT_SELF_CHECK_CONFIG, enabled: true, ...overrides });

describe("runSelfCheckPass", () => {
  it("emits a no-op pass when disabled (default config)", () => {
    const result = runSelfCheckPass({
      changedPaths: ["src/foo.ts"],
      diff: "diff --git a/src/foo.ts b/src/foo.ts\n",
      summary: "touched foo.ts"
    });

    expect(result.verdict).toBe("pass");
    expect(result.issues).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.receipt).toContain("skipped");
    expect(result.receipt).toContain("changedPaths: 1");
  });

  it("returns a clean pass for an empty change set when enabled", () => {
    const result = runSelfCheckPass({ changedPaths: [], diff: "", summary: "" }, enabled());

    expect(result.verdict).toBe("pass");
    expect(result.issues).toEqual([]);
    expect(result.skipped).toBe(false);
    expect(result.receipt).toContain("issues: 0");
  });

  it("flags a summary that has no diff or changed paths to back it", () => {
    const result = runSelfCheckPass(
      { changedPaths: [], diff: "", summary: "implemented F84 self-check" },
      enabled()
    );

    expect(result.verdict).toBe("issues");
    expect(result.issues.map((issue) => issue.code)).toContain("summary-without-evidence");
    expect(result.issues[0]?.severity).toBe("high");
    expect(result.receipt).toContain("summary-without-evidence");
  });

  it("flags changedPaths-without-diff as a HIGH empty-diff issue", () => {
    const result = runSelfCheckPass(
      { changedPaths: ["src/review/selfCheckPass.ts"], diff: "", summary: "" },
      enabled()
    );

    expect(result.verdict).toBe("issues");
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("empty-diff");
    expect(codes).not.toContain("summary-without-evidence");
  });

  it("flags secret-shaped additions with file and line info", () => {
    // The fixture below simulates a developer accidentally pasting a real
    // AWS-shaped access key. The literal MUST remain a 20-char AKIA… uppercase
    // string so the secret marker regex (`\bAKIA[0-9A-Z]{16}\b`) matches, and
    // the pass is what we are testing. Append a `.fixture` tag in a comment so
    // readers (and the pass running against this very diff) can tell the
    // string is a sentinel and not a leaked credential.
    const diff = [
      "diff --git a/src/config.ts b/src/config.ts",
      "index 0000..1111 100644",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+const token = \"AKIAIOSFODNN7EXAMPLE\"; // fixture: sentinel AWS-shaped key"
    ].join("\n");

    const result = runSelfCheckPass(
      { changedPaths: ["src/config.ts"], diff, summary: "added token" },
      enabled()
    );

    expect(result.verdict).toBe("issues");
    const secretIssue = result.issues.find((issue) => issue.code === "secret-shaped-addition");
    expect(secretIssue).toBeDefined();
    expect(secretIssue?.file).toBe("src/config.ts");
    expect(secretIssue?.line).toBe(2);
  });

  it("flags risky-path writes against runtime-supplied patterns", () => {
    const result = runSelfCheckPass(
      { changedPaths: [".env.local", "src/ok.ts"], diff: "+++ b/.env.local\n+x=1", summary: "wrote env" },
      enabled(),
      [".env"]
    );

    expect(result.verdict).toBe("issues");
    const risky = result.issues.find((issue) => issue.code === "risky-path");
    expect(risky).toBeDefined();
    expect(risky?.file).toBe(".env.local");
  });

  it("truncates issues to the configured maxIssues cap", () => {
    const config = enabled({ maxIssues: 1 });
    const result = runSelfCheckPass(
      {
        changedPaths: [".env", ".ssh/id_rsa"],
        diff: "",
        summary: "did a bunch of things"
      },
      config,
      [".env", ".ssh"]
    );

    expect(result.issues.length).toBe(1);
    // The receipt MUST match the trimmed issues — never the untrimmed count.
    expect(result.receipt).toContain("issues: 1");
  });

  it("drops findings below the configured minSeverity", () => {
    // The current shape only emits HIGH issues, so this guards against future
    // expansion: a minSeverity of "high" must never surface a low-severity note.
    const result = runSelfCheckPass(
      { changedPaths: ["src/foo.ts"], diff: "+++ b/src/foo.ts\n+noop", summary: "noop" },
      enabled({ minSeverity: "high" })
    );

    expect(result.verdict).toBe("pass");
    expect(result.issues).toEqual([]);
  });
});

describe("formatReceipt", () => {
  it("renders an empty receipt block when there are no issues", () => {
    const receipt = formatReceipt({ verdict: "pass", issues: [], skipped: false, changedPaths: [] });

    expect(receipt).toContain("self-check pass");
    expect(receipt).toContain("issues: 0");
  });

  it("renders one line per issue with severity, code, location, and message", () => {
    const receipt = formatReceipt({
      verdict: "issues",
      skipped: false,
      changedPaths: ["src/foo.ts"],
      issues: [
        { code: "risky-path", severity: "high", message: "touched risky path", file: "src/foo.ts", line: 7 }
      ]
    });

    expect(receipt).toContain("self-check issues");
    expect(receipt).toContain("[high] risky-path @ src/foo.ts:7");
    expect(receipt).toContain("touched risky path");
  });
});
