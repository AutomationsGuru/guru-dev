import {
  buildBwrapArgv,
  buildSandboxedCommand,
  currentPlatform,
  detectSandbox,
  probeHostCapabilities,
  type CapabilityProbe,
  type SandboxAvailability
} from '../../src/sandbox/osProfile.js';

/**
 * Tests never invoke bwrap and never require root. Every probe is injected;
 * the production probe is exercised only through a stubbed `lookupBinary`.
 */

const availableLinux: SandboxAvailability = {
  kind: "available",
  platform: "linux",
  binary: "bwrap",
  reason: "stubbed available"
};

const missingLinux: SandboxAvailability = {
  kind: "missing-binary",
  platform: "linux",
  reason: "stubbed missing"
};

const unsupportedDarwin: SandboxAvailability = {
  kind: "unsupported-platform",
  platform: "darwin",
  reason: "stubbed darwin"
};

function probeReturning(record: SandboxAvailability): CapabilityProbe {
  return () => record;
}

describe("currentPlatform", () => {
  it("maps Node platforms to the profile union", () => {
    expect(currentPlatform("linux")).toBe("linux");
    expect(currentPlatform("darwin")).toBe("darwin");
    expect(currentPlatform("win32")).toBe("win32");
    expect(currentPlatform("freebsd")).toBe("other");
    expect(currentPlatform("aix")).toBe("other");
  });
});

describe("probeHostCapabilities", () => {
  it("reports unsupported-platform on darwin with the v1 exclusion called out", () => {
    const record = probeHostCapabilities("darwin", () => true);
    expect(record.kind).toBe("unsupported-platform");
    expect(record.platform).toBe("darwin");
    expect(record.reason).toContain("Seatbelt");
    expect(record.reason).toContain("v1");
  });

  it("reports unsupported-platform on win32 with the v1 exclusion called out", () => {
    const record = probeHostCapabilities("win32", () => true);
    expect(record.kind).toBe("unsupported-platform");
    expect(record.platform).toBe("win32");
    expect(record.reason).toContain("AppContainer");
  });

  it("reports unsupported-platform on any other host", () => {
    const record = probeHostCapabilities("other", () => true);
    expect(record.kind).toBe("unsupported-platform");
    expect(record.platform).toBe("other");
  });

  it("reports missing-binary on linux when bwrap is not on PATH", () => {
    const record = probeHostCapabilities("linux", () => false);
    expect(record.kind).toBe("missing-binary");
    expect(record.reason).toContain("bwrap");
  });

  it("reports available on linux when bwrap is on PATH", () => {
    const record = probeHostCapabilities("linux", () => true);
    expect(record.kind).toBe("available");
    expect(record.binary).toBe("bwrap");
  });
});

describe("detectSandbox", () => {
  it("returns disabled by default — never silently active", () => {
    const record = detectSandbox();
    expect(record.kind).toBe("disabled");
    expect(record.reason).toContain("disabled by default");
  });

  it("returns disabled even on a capable host when enabled is not true", () => {
    const record = detectSandbox({}, probeReturning(availableLinux));
    expect(record.kind).toBe("disabled");
  });

  it("returns disabled when enabled is explicitly false", () => {
    const record = detectSandbox({ enabled: false }, probeReturning(availableLinux));
    expect(record.kind).toBe("disabled");
  });

  it("forwards to the probe when enabled", () => {
    const record = detectSandbox({ enabled: true, workspaceRoot: "/workspace" }, probeReturning(availableLinux));
    expect(record.kind).toBe("available");
  });

  it("honestly reports unsupported-platform when enabled on darwin", () => {
    const record = detectSandbox({ enabled: true, workspaceRoot: "/workspace" }, probeReturning(unsupportedDarwin));
    expect(record.kind).toBe("unsupported-platform");
  });
});

describe("buildSandboxedCommand", () => {
  it("returns unwrapped+disabled by default (never silent)", () => {
    const result = buildSandboxedCommand(["echo", "hi"]);
    expect(result.wrapped).toBe(false);
    if (!result.wrapped) {
      expect(result.availability.kind).toBe("disabled");
    }
  });

  it("returns unwrapped when the probe reports the capability is missing", () => {
    const result = buildSandboxedCommand(["echo", "hi"], { enabled: true, workspaceRoot: "/workspace" }, probeReturning(missingLinux));
    expect(result.wrapped).toBe(false);
    if (!result.wrapped) {
      expect(result.availability.kind).toBe("missing-binary");
    }
  });

  it("returns unwrapped when the platform is unsupported", () => {
    const result = buildSandboxedCommand(["echo", "hi"], { enabled: true, workspaceRoot: "/workspace" }, probeReturning(unsupportedDarwin));
    expect(result.wrapped).toBe(false);
    if (!result.wrapped) {
      expect(result.availability.kind).toBe("unsupported-platform");
    }
  });

  it("refuses to wrap when enabled but workspaceRoot is missing", () => {
    const result = buildSandboxedCommand(["echo", "hi"], { enabled: true }, probeReturning(availableLinux));
    expect(result.wrapped).toBe(false);
    if (!result.wrapped) {
      expect(result.availability.reason).toContain("workspaceRoot");
    }
  });

  it("refuses to wrap when workspaceRoot is not absolute", () => {
    const result = buildSandboxedCommand(["echo", "hi"], { enabled: true, workspaceRoot: "relative/path" }, probeReturning(availableLinux));
    expect(result.wrapped).toBe(false);
  });

  it("refuses to wrap when command argv is empty", () => {
    const result = buildSandboxedCommand([], { enabled: true, workspaceRoot: "/workspace" }, probeReturning(availableLinux));
    expect(result.wrapped).toBe(false);
  });

  it("wraps with bwrap when available and enabled", () => {
    const result = buildSandboxedCommand(["echo", "hi"], { enabled: true, workspaceRoot: "/workspace" }, probeReturning(availableLinux));
    expect(result.wrapped).toBe(true);
    if (result.wrapped) {
      expect(result.argv[0]).toBe("bwrap");
      expect(result.argv.slice(-2)).toEqual(["echo", "hi"]);
      expect(result.summary).toContain("bwrap");
    }
  });

  it("disables network by default", () => {
    const result = buildSandboxedCommand(["echo"], { enabled: true, workspaceRoot: "/workspace" }, probeReturning(availableLinux));
    expect(result.wrapped).toBe(true);
    if (result.wrapped) {
      expect(result.argv).toContain("--unshare-net");
      expect(result.summary).toContain("network disabled (default)");
    }
  });

  it("keeps network when allowNetwork is explicitly true", () => {
    const result = buildSandboxedCommand(["echo"], { enabled: true, workspaceRoot: "/workspace", allowNetwork: true }, probeReturning(availableLinux));
    expect(result.wrapped).toBe(true);
    if (result.wrapped) {
      expect(result.argv).not.toContain("--unshare-net");
      expect(result.summary).toContain("explicit opt-in");
    }
  });
});

describe("buildBwrapArgv confinement shape", () => {
  it("binds the workspace read-write exactly once", () => {
    const argv = buildBwrapArgv(["echo"], {
      workspaceRoot: "/workspace",
      allowNetwork: false,
      extraReadOnlyMounts: []
    });
    const bindIndices: number[] = [];
    argv.forEach((token, index) => {
      if (token === "--bind") bindIndices.push(index);
    });
    expect(bindIndices).toHaveLength(1);
    const index = bindIndices[0]!;
    expect(argv[index + 1]).toBe("/workspace");
    expect(argv[index + 2]).toBe("/workspace");
  });

  it("never binds any other host path read-write", () => {
    const argv = buildBwrapArgv(["echo"], {
      workspaceRoot: "/workspace",
      allowNetwork: false,
      extraReadOnlyMounts: ["/opt/toolkit"]
    });
    // Only one --bind (read-write). Everything else must be --ro-bind / --ro-bind-try / --tmpfs.
    const rwBinds = argv.filter((token) => token === "--bind");
    expect(rwBinds).toHaveLength(1);
  });

  it("marks extra mounts read-only and chdirs into the workspace", () => {
    const argv = buildBwrapArgv(["echo"], {
      workspaceRoot: "/workspace",
      allowNetwork: false,
      extraReadOnlyMounts: ["/opt/toolkit"]
    });
    const roIdx = argv.findIndex((token, i) => token === "--ro-bind" && argv[i + 1] === "/opt/toolkit");
    expect(roIdx).toBeGreaterThanOrEqual(0);
    const chdirIdx = argv.findIndex((token) => token === "--chdir");
    expect(argv[chdirIdx + 1]).toBe("/workspace");
  });

  it("skips non-absolute extra mounts defensively", () => {
    const argv = buildBwrapArgv(["echo"], {
      workspaceRoot: "/workspace",
      allowNetwork: false,
      extraReadOnlyMounts: ["relative/path", "/opt/toolkit"]
    });
    expect(argv).not.toContain("relative/path");
    expect(argv).toContain("/opt/toolkit");
  });

  it("separates sandbox args from the wrapped command with --", () => {
    const argv = buildBwrapArgv(["npm", "test"], {
      workspaceRoot: "/workspace",
      allowNetwork: false,
      extraReadOnlyMounts: []
    });
    const dashIdx = argv.lastIndexOf("--");
    expect(dashIdx).toBeGreaterThan(0);
    expect(argv.slice(dashIdx + 1)).toEqual(["npm", "test"]);
  });

  it("sets the hardening flags", () => {
    const argv = buildBwrapArgv(["echo"], {
      workspaceRoot: "/workspace",
      allowNetwork: false,
      extraReadOnlyMounts: []
    });
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--unshare-user");
    expect(argv).toContain("--unshare-pid");
  });
});
