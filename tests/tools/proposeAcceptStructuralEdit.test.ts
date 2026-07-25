import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProposeAcceptStructuralEditTool } from "../../src/tools/proposeAcceptStructuralEdit.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const tempDirectories: string[] = [];
const riskyPathPatterns = [".git", ".env", "secrets", "credentials", "id_rsa"];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("createProposeAcceptStructuralEditTool", () => {
  it("propose stages a pending edit without writing and returns a proposalId + redacted preview", async () => {
    const repoRoot = makeTempDirectory();
    writeFileSync(join(repoRoot, "src.txt"), "alpha\nbeta\n");
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "propose",
      repoRoot,
      path: "src.txt",
      oldText: "beta",
      newText: "gamma"
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({
      action: "propose",
      staged: true,
      applied: false,
      path: "src.txt"
    });
    const output = observation.output as { proposalId: string; previewDiff: string };
    expect(typeof output.proposalId).toBe("string");
    expect(output.proposalId.length).toBeGreaterThan(0);
    expect(JSON.stringify(observation.output)).toContain("redacted");
    // Crucial propose-then-accept guarantee: nothing is written at propose time.
    expect(readFileSync(join(repoRoot, "src.txt"), "utf8")).toBe("alpha\nbeta\n");
  });

  it("reject discards a pending proposal without applying it", async () => {
    const repoRoot = makeTempDirectory();
    writeFileSync(join(repoRoot, "src.txt"), "alpha\nbeta\n");
    const registry = createRegistry();

    const proposed = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "propose",
      repoRoot,
      path: "src.txt",
      oldText: "beta",
      newText: "gamma"
    });
    const proposalId = (proposed.output as { proposalId: string }).proposalId;

    const rejected = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "reject",
      proposalId
    });

    expect(rejected.status).toBe("succeeded");
    expect(rejected.output).toMatchObject({
      action: "reject",
      discarded: true,
      applied: false
    });
    // File unchanged after reject.
    expect(readFileSync(join(repoRoot, "src.txt"), "utf8")).toBe("alpha\nbeta\n");

    // And the proposal is gone: a later accept must fail.
    const lateAccept = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "accept",
      proposalId
    });
    expect(lateAccept.output).toMatchObject({ action: "accept", applied: false });
  });

  it("accept applies a staged proposal to disk exactly once", async () => {
    const repoRoot = makeTempDirectory();
    writeFileSync(join(repoRoot, "src.txt"), "alpha\nbeta\n");
    const registry = createRegistry();

    const proposed = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "propose",
      repoRoot,
      path: "src.txt",
      oldText: "beta",
      newText: "gamma"
    });
    const proposalId = (proposed.output as { proposalId: string }).proposalId;

    const accepted = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "accept",
      proposalId
    });

    expect(accepted.status).toBe("succeeded");
    expect(accepted.output).toMatchObject({
      action: "accept",
      applied: true,
      path: "src.txt",
      replacements: 1
    });
    expect(readFileSync(join(repoRoot, "src.txt"), "utf8")).toBe("alpha\ngamma\n");

    // Second accept of the same id is gone from the store — must not re-apply or double-write.
    const secondAccept = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "accept",
      proposalId
    });
    expect(secondAccept.output).toMatchObject({ applied: false });
    expect(readFileSync(join(repoRoot, "src.txt"), "utf8")).toBe("alpha\ngamma\n");
  });

  it("accept with an unknown proposalId does not apply anything", async () => {
    const repoRoot = makeTempDirectory();
    writeFileSync(join(repoRoot, "src.txt"), "alpha\n");
    const registry = createRegistry();

    const accepted = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "accept",
      proposalId: "does-not-exist"
    });

    expect(accepted.status).toBe("succeeded");
    expect(accepted.output).toMatchObject({ action: "accept", applied: false });
    expect(readFileSync(join(repoRoot, "src.txt"), "utf8")).toBe("alpha\n");
  });

  it("propose blocks risky paths and secret-bearing content without leaking the secret", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";

    const risky = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "propose",
      repoRoot,
      path: ".env",
      oldText: "a",
      newText: "b"
    });
    expect(risky.output).toMatchObject({ action: "propose", staged: false });
    expect(JSON.stringify(risky.output)).toContain("risky-path policy");

    const leaky = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "propose",
      repoRoot,
      path: "src.txt",
      oldText: "x",
      newText: `token=${secret}`
    });
    expect(leaky.output).toMatchObject({ action: "propose", staged: false });
    expect(JSON.stringify(leaky.output)).toContain("github-token");
    expect(JSON.stringify(leaky.output)).not.toContain(secret);
  });

  it("isolates proposals by id so two concurrent proposals do not collide", async () => {
    const repoRoot = makeTempDirectory();
    writeFileSync(join(repoRoot, "a.txt"), "one");
    writeFileSync(join(repoRoot, "b.txt"), "two");
    const registry = createRegistry();

    const pa = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "propose",
      repoRoot,
      path: "a.txt",
      oldText: "one",
      newText: "ONE"
    });
    const pb = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "propose",
      repoRoot,
      path: "b.txt",
      oldText: "two",
      newText: "TWO"
    });
    const idA = (pa.output as { proposalId: string }).proposalId;
    const idB = (pb.output as { proposalId: string }).proposalId;
    expect(idA).not.toBe(idB);

    // Reject A, accept B.
    await executeRegisteredTool(registry, "edit.proposeAccept", { action: "reject", proposalId: idA });
    await executeRegisteredTool(registry, "edit.proposeAccept", { action: "accept", proposalId: idB });

    expect(readFileSync(join(repoRoot, "a.txt"), "utf8")).toBe("one");
    expect(readFileSync(join(repoRoot, "b.txt"), "utf8")).toBe("TWO");
  });

  it("refuses to accept a proposal whose target has drifted since propose time", async () => {
    const repoRoot = makeTempDirectory();
    writeFileSync(join(repoRoot, "src.txt"), "alpha\nbeta\n");
    const registry = createRegistry();

    const proposed = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "propose",
      repoRoot,
      path: "src.txt",
      oldText: "beta",
      newText: "gamma"
    });
    const proposalId = (proposed.output as { proposalId: string }).proposalId;

    // External mutation between propose and accept: the matched text is gone,
    // so the staged oldText no longer matches the file as staged.
    writeFileSync(join(repoRoot, "src.txt"), "alpha\nDELTA\n");

    const accepted = await executeRegisteredTool(registry, "edit.proposeAccept", {
      action: "accept",
      proposalId
    });

    expect(accepted.output).toMatchObject({ action: "accept", applied: false });
    expect(JSON.stringify(accepted.output)).toContain("no longer matches");
    // File left exactly as the external actor left it.
    expect(readFileSync(join(repoRoot, "src.txt"), "utf8")).toBe("alpha\nDELTA\n");
  });
});

function createRegistry() {
  return createToolRegistry([
    createProposeAcceptStructuralEditTool({
      riskyPathPatterns,
      secretAllowList: [],
      allowRiskyPaths: false
    })
  ]);
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-propose-accept-"));
  tempDirectories.push(directory);

  return directory;
}
