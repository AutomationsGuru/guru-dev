import { describe, expect, it } from "vitest";

import {
  HOSTED_SHELL_BACKEND_ID,
  HOSTED_SHELL_NOT_CONFIGURED_CODE,
  HOSTED_SHELL_NOT_CONFIGURED_MESSAGE,
  createHostedShellStub,
  defaultHostedShellStub,
  execHostedShell,
  type HostedShellExecFailure,
  type HostedShellExecRequest,
} from '../../src/sandbox/hostedShellStub.js';

describe("hostedShellStub (IDEA-F252-HOSTED-SHELL-01)", () => {
  it('createHostedShellStub returns kind "hosted" and id "hosted" by default', () => {
    const backend = createHostedShellStub();
    expect(backend.kind).toBe("hosted");
    expect(backend.id).toBe(HOSTED_SHELL_BACKEND_ID);
    expect(backend.id).toBe("hosted");
  });

  it("createHostedShellStub accepts a custom id", () => {
    const backend = createHostedShellStub({ id: "custom-hosted" });
    expect(backend.kind).toBe("hosted");
    expect(backend.id).toBe("custom-hosted");
  });

  it('exec always returns { ok: false, code: "not-configured" } with a clear message', async () => {
    const backend = createHostedShellStub();
    const result = await backend.exec({ command: ["echo", "hello"] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failure: HostedShellExecFailure = result;
      expect(failure.code).toBe(HOSTED_SHELL_NOT_CONFIGURED_CODE);
      expect(failure.code).toBe("not-configured");
      expect(failure.message).toBe(HOSTED_SHELL_NOT_CONFIGURED_MESSAGE);
      expect(failure.message).toMatch(/not configured/i);
      expect(failure.message).toMatch(/fail/i);
    }
  });

  it("message is clear about hosted shell, not configured, fails closed, and container_auto/attach", async () => {
    const result = await createHostedShellStub().exec({ command: ["true"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/hosted shell/i);
      expect(result.message).toMatch(/not configured/i);
      expect(result.message).toMatch(/fails closed/i);
      expect(result.message).toMatch(/container_auto|attach/i);
    }
  });

  it("defaultHostedShellStub also fails closed", async () => {
    expect(defaultHostedShellStub.kind).toBe("hosted");
    expect(defaultHostedShellStub.id).toBe("hosted");

    const result = await defaultHostedShellStub.exec({ command: ["uname", "-a"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-configured");
      expect(result.message).toMatch(/not configured/i);
      expect(result.message).toMatch(/fail/i);
    }
  });

  it("execHostedShell fails closed via the default stub", async () => {
    const result = await execHostedShell({ command: ["pwd"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-configured");
      expect(result.message).toBe(HOSTED_SHELL_NOT_CONFIGURED_MESSAGE);
    }
  });

  it("request is not executed — still fails closed for any command payload", async () => {
    const request: HostedShellExecRequest = {
      command: ["rm", "-rf", "/"],
      cwd: "/tmp",
      timeoutMs: 1,
      env: { HOSTED_SHELL_SHOULD_NOT_RUN: "1" },
    };

    const result = await createHostedShellStub().exec(request);
    expect(result).toEqual({
      ok: false,
      code: "not-configured",
      message: HOSTED_SHELL_NOT_CONFIGURED_MESSAGE,
    });
    // Discriminated failure — no success fields (stdout/stderr/exitCode).
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("exitCode");
  });

  it("does not throw; callers receive a coded result", async () => {
    await expect(
      createHostedShellStub().exec({ command: ["echo", "no throw"] }),
    ).resolves.toMatchObject({
      ok: false,
      code: "not-configured",
    });
  });
});
