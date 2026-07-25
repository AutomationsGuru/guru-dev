import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_STUB_BACKEND_ID,
  LocalStubBackend,
  type RemoteSandboxBackend
} from '../../src/sandbox/remoteSandboxBackend.js';

describe("remoteSandboxBackend seam (IDEA-F215-REMOTE-SBX-01)", () => {
  let rootDir: string;
  let backend: RemoteSandboxBackend;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "guru-f215-sbx-"));
    backend = new LocalStubBackend({ rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("stub exec returns ok for a successful command", async () => {
    const result = await backend.exec({ command: ["node", "-e", "process.stdout.write('ok')"] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("");
    expect(result.cancelled).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stub identity is the honest local-stub kind, not a sandbox claim", () => {
    expect(backend.id).toBe(LOCAL_STUB_BACKEND_ID);
    expect(backend.id).toBe("local");
    expect(backend.kind).toBe("local-stub");
  });

  it("exec reports a non-zero exit code without rejecting", async () => {
    const result = await backend.exec({ command: ["node", "-e", "process.exit(3)"] });

    expect(result.exitCode).toBe(3);
  });

  it("exec rejects on an empty argv instead of spawning a shell", async () => {
    await expect(backend.exec({ command: [] })).rejects.toThrow(/non-empty command argv/);
  });

  it("exec honors the abort seam and marks the result cancelled", async () => {
    const controller = new AbortController();
    const pending = backend.exec({
      command: ["node", "-e", "setTimeout(() => {}, 10_000)"],
      signal: controller.signal
    });
    controller.abort();

    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("write then read round-trips content through the sandbox root", async () => {
    await backend.write({ path: "nested/out.txt", content: "hello sandbox" });

    const readBack = await backend.read({ path: "nested/out.txt" });
    expect(readBack.content).toBe("hello sandbox");
  });

  it("read rejects for a missing path (no silent empty content)", async () => {
    await expect(backend.read({ path: "does-not-exist.txt" })).rejects.toThrow();
  });
});
