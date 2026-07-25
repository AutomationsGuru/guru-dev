import { describe, expect, it } from "vitest";

import {
  createLocalRemoteExecBackend,
  createNoopRemoteExecBackend,
  getRemoteExecBackend,
  listRemoteExecBackends,
  REMOTE_EXEC_PARITY_GAP_PREFIX,
  registerRemoteExecBackend,
  RemoteExecParityGapError,
  removeRemoteExecBackend
} from "../../src/sandbox/remoteExecAttach.js";
import { RemoteExecBackendConfigSchema } from "../../src/sandbox/remoteExecAttach.js";

describe("remote exec ATTACH stub", () => {
  it("local default backend resolves workspace paths without network I/O", async () => {
    const backend = createLocalRemoteExecBackend({ id: "local-default" });
    try {
      expect(backend.kind).toBe("local");
      expect(backend.status).toBe("ready");

      const resolved = await backend.resolvePath("README.md");
      expect(resolved).not.toContain("\0");
      // Local path resolution is pure string composition; never throws, never dials out.
      expect(typeof resolved).toBe("string");
      expect(resolved.length).toBeGreaterThan(0);

      const ls = await backend.listFiles("README.md");
      expect(ls.ok).toBe(true);
      expect(Array.isArray(ls.entries)).toBe(true);
    } finally {
      removeRemoteExecBackend(backend.id);
    }
  });

  it("defaults a bare config to the local kind", () => {
    const parsed = RemoteExecBackendConfigSchema.parse({ id: "bare-local" });
    expect(parsed.kind).toBe("local");
    expect(parsed.enabled).toBe(false);
  });

  it("fails to enable a remote backend without a parityGapId", () => {
    expect(() =>
      createNoopRemoteExecBackend({ id: "ssh-stub", kind: "ssh", enabled: true })
    ).toThrow(RemoteExecParityGapError);
    expect(() =>
      createNoopRemoteExecBackend({ id: "ssh-stub", kind: "ssh", enabled: true })
    ).toThrow(REMOTE_EXEC_PARITY_GAP_PREFIX);
    expect(() =>
      registerRemoteExecBackend({ id: "ssh-stub", kind: "ssh", enabled: true })
    ).toThrow(/parityGapId/u);
  });

  it("enables a remote backend with a parityGapId and noop exec returns the structured stub result", async () => {
    const backend = registerRemoteExecBackend({
      id: "remote-ssh-stub",
      kind: "ssh",
      enabled: true,
      parityGapId: "R-DA-REMOTE",
      config: { hostEnvVar: "GURU_REMOTE_HOST", keyEnvVar: "GURU_REMOTE_KEY" }
    });
    try {
      expect(backend.kind).toBe("ssh");
      expect(backend.status).toBe("ready");
      await backend.connect();
      expect(backend.status).toBe("enabled");

      const result = await backend.exec("echo hello stub");
      expect(result).toEqual({
        delivered: false,
        reason: "noop-stub",
        backendId: "remote-ssh-stub"
      });

      await backend.disconnect();
      expect(backend.status).toBe("ready");
    } finally {
      removeRemoteExecBackend(backend.id);
    }
  });

  it("rejects an empty backend id", () => {
    expect(() => RemoteExecBackendConfigSchema.parse({ id: "", kind: "local" })).toThrow();
    expect(() => RemoteExecBackendConfigSchema.parse({ id: "   ", kind: "local" })).toThrow();
  });

  it("schema parse rejects remote+enabled without parityGapId (raw schema, not factory)", () => {
    const attempt = RemoteExecBackendConfigSchema.safeParse({
      id: "raw-ssh",
      kind: "ssh",
      enabled: true
    });
    expect(attempt.success).toBe(false);
    if (!attempt.success) {
      const gapIssue = attempt.error.issues.find((issue) => issue.path.includes("parityGapId"));
      expect(gapIssue).toBeDefined();
      expect(gapIssue?.message).toMatch(/parityGapId/u);
    }
  });

  it("schema rejects config map values that are not env-var-name shaped", () => {
    expect(() =>
      RemoteExecBackendConfigSchema.parse({
        id: "raw-secret",
        kind: "ssh",
        config: { key: "ssh-key-blob-secret-value" }
      })
    ).toThrow(/environment variable name/u);
    expect(() =>
      RemoteExecBackendConfigSchema.parse({
        id: "url-value",
        kind: "ssh",
        config: { host: "user@10.0.0.5" }
      })
    ).toThrow(/environment variable name/u);
    expect(() =>
      RemoteExecBackendConfigSchema.parse({ id: "numeric-value", kind: "ssh", config: { port: "22" } })
    ).toThrow(/environment variable name/u);
  });

  it("schema accepts a valid config with env-name values and enabled with parityGapId", () => {
    const parsed = RemoteExecBackendConfigSchema.parse({
      id: "valid-ssh",
      kind: "ssh",
      enabled: true,
      parityGapId: "R-DA-REMOTE",
      config: { hostEnvVar: "GURU_REMOTE_HOST", keyEnvVar: "GURU_REMOTE_KEY" }
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.parityGapId).toBe("R-DA-REMOTE");
    expect(parsed.config.hostEnvVar).toBe("GURU_REMOTE_HOST");
  });

  it("registry supports register/get/list/remove", () => {
    const backend = registerRemoteExecBackend({ id: "container-stub", kind: "container" });
    try {
      expect(getRemoteExecBackend("container-stub")).toBe(backend);
      expect(listRemoteExecBackends().some((entry) => entry.id === "container-stub")).toBe(true);
      expect(removeRemoteExecBackend("container-stub")).toBe(true);
      expect(getRemoteExecBackend("container-stub")).toBeUndefined();
    } finally {
      removeRemoteExecBackend(backend.id);
    }
  });

  it("local backend never performs network I/O even when connect/disconnect are called", async () => {
    const backend = createLocalRemoteExecBackend({ id: "local-noop", enabled: true, parityGapId: "R-DA-REMOTE" });
    try {
      // Local kind is always ready regardless of enabled flag — it owns no remote host.
      expect(backend.status).toBe("ready");
      await backend.connect();
      expect(backend.status).toBe("ready");
      await backend.disconnect();
      expect(backend.status).toBe("ready");
    } finally {
      removeRemoteExecBackend(backend.id);
    }
  });
});
