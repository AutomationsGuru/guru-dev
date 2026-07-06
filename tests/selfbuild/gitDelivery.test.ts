import { describe, expect, it, vi } from "vitest";

import { makeGatedGitDelivery } from "../../src/selfbuild/gitDelivery.js";
import { ChangeRecordSchema } from "../../src/selfbuild/shipStage.js";
import type { MandatePolicyFn } from "../../src/executor/selfBuildExecutor.js";

const payload = ChangeRecordSchema.parse({ taskId: "deliver-me", summary: "s", stages: [] });
const ctx = { gitPresent: true, ghPresent: true };

const allow: MandatePolicyFn = () => ({ outcome: "allow", reason: "granted", verbs: [] });
const escalate: MandatePolicyFn = () => ({ outcome: "escalate", reason: "no grant covers push", verbs: [] });
const okGit = () => ({ exitCode: 0, stdout: "", stderr: "" });

describe("makeGatedGitDelivery (P5/P7) — push routes through the mandate gate", () => {
  it("gate blocks the push (fail-closed) → durable change-record, NEVER pushes", async () => {
    const runGit = vi.fn(okGit);
    const wrote: string[] = [];
    const delivery = makeGatedGitDelivery({
      cwd: "/repo",
      policy: escalate,
      payload,
      runGit,
      writeChangeRecord: (_r, path) => {
        wrote.push(path);
      }
    });
    const result = await delivery(ctx);
    expect(result.target).toBe("local-record");
    expect(result.verdict).toBe("YELLOW");
    expect(result.evidence).toMatch(/gated/u);
    expect(runGit).not.toHaveBeenCalled(); // the gate stopped the push
    expect(wrote).toHaveLength(1);
  });

  it("gate allows (explicit grant) → commit + push → GREEN (git+pr when gh present)", async () => {
    const runGit = vi.fn(okGit);
    const delivery = makeGatedGitDelivery({ cwd: "/repo", policy: allow, payload, runGit });
    const result = await delivery(ctx);
    expect(result.verdict).toBe("GREEN");
    expect(result.target).toBe("git+pr");
    expect(runGit).toHaveBeenCalledTimes(2); // commit + push
  });

  it("nothing to commit → YELLOW local-record (never a false GREEN, never pushes)", async () => {
    const runGit = vi.fn((args: readonly string[]) =>
      args[0] === "commit" ? { exitCode: 1, stdout: "", stderr: "nothing to commit, working tree clean" } : okGit()
    );
    const wrote: string[] = [];
    const delivery = makeGatedGitDelivery({ cwd: "/repo", policy: allow, payload, runGit, writeChangeRecord: (_r, path) => { wrote.push(path); } });
    const result = await delivery(ctx);
    expect(result.verdict).toBe("YELLOW");
    expect(result.target).toBe("local-record");
    expect(runGit).toHaveBeenCalledTimes(1); // commit attempted; push NOT reached
    expect(wrote).toHaveLength(1);
  });

  it("a real commit failure → RED (not a false ship)", async () => {
    const runGit = vi.fn((args: readonly string[]) =>
      args[0] === "commit" ? { exitCode: 1, stdout: "", stderr: "fatal: pathspec error" } : okGit()
    );
    const delivery = makeGatedGitDelivery({ cwd: "/repo", policy: allow, payload, runGit });
    const result = await delivery(ctx);
    expect(result.verdict).toBe("RED");
  });

  it("a failed push → RED (surfaced, not silently swallowed)", async () => {
    const runGit = vi.fn((args: readonly string[]) => (args[0] === "push" ? { exitCode: 1, stdout: "", stderr: "rejected" } : okGit()));
    const delivery = makeGatedGitDelivery({ cwd: "/repo", policy: allow, payload, runGit });
    const result = await delivery(ctx);
    expect(result.verdict).toBe("RED");
    expect(result.evidence).toMatch(/rejected/u);
  });
});
