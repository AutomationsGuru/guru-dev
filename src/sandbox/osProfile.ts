/**
 * Optional OS-level sandbox profile for child processes (IDEA-E4-OS-SANDBOX-01).
 *
 * Status: OPTIONAL, DISABLED BY DEFAULT. The harness boots and runs without it.
 * This module never becomes a silent dependency — it is explicit, gated, and
 * reports its own availability honestly. When the host cannot provide the
 * profile it returns a structured `unavailable` rather than faking enforcement
 * or throwing (VISION §1.2 "starts from almost nothing and says what it is
 * missing"; §1.5 "attach is always provisional and visible").
 *
 * v1 scope:
 *   - Linux: bubblewrap (`bwrap`) when present on PATH. Workspace writes are
 *     bind-mounted read-write; everything else is read-only; network is
 *     disabled by default (`--unshare-net`).
 *   - macOS Seatbelt / Windows AppContainer: explicitly NOT implemented in v1
 *     (plan exclusion). Reported as `unsupported-platform`.
 *   - No root requirement: bubblewrap runs unprivileged via user namespaces.
 *     Tests mock the capability probe and never invoke `bwrap` for real.
 *
 * Design rules enforced structurally here (not in prompts):
 *   1. Default state is DISABLED. Callers must pass `enabled: true` explicitly.
 *   2. `enabled: true` + capability missing ⇒ structured `unavailable`, never
 *      a silent fall-through to unsandboxed execution. The caller decides how
 *      to surface that to the operator; this module never lies about posture.
 *   3. When wrapping, the workspace root is the ONLY writable mount. Nothing
 *      outside the workspace is bound read-write. Network is OFF unless the
 *      caller explicitly opts in (`allowNetwork: true`).
 *   4. No secret values are read or logged here. This module assembles argv
 *      only; it never inspects command output.
 */

import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Operating systems the v1 profile knows about. */
export type SandboxPlatform = "linux" | "darwin" | "win32" | "other";

export type SandboxAvailabilityKind =
  /** Profile can wrap commands on this host right now. */
  | "available"
  /** Host OS has no v1 implementation (macOS Seatbelt, Windows AppContainer, other). */
  | "unsupported-platform"
  /** Linux host but bubblewrap was not found on PATH. */
  | "missing-binary"
  /** Caller asked for the profile but did not enable it. */
  | "disabled";

export interface SandboxAvailability {
  readonly kind: SandboxAvailabilityKind;
  readonly platform: SandboxPlatform;
  /** Short human legible reason; no secrets, no absolute host paths beyond the binary name. */
  readonly reason: string;
  /** Binary that would be used when `kind === "available"`. */
  readonly binary?: "bwrap";
}

export interface SandboxProfileOptions {
  /**
   * Explicit opt-in. Default false — sandbox is NEVER silently active.
   * When false, `detectSandbox` returns `{ kind: "disabled" }` and
   * `buildSandboxedCommand` refuses to wrap.
   */
  readonly enabled?: boolean;
  /**
   * Absolute workspace root. Writes are confined to this tree when wrapping.
   * Required when `enabled: true`.
   */
  readonly workspaceRoot?: string;
  /**
   * Network is OFF by default. Setting `allowNetwork: true` is an explicit
   * operator choice; the profile never enables it implicitly.
   */
  readonly allowNetwork?: boolean;
  /**
   * Extra read-only bind mounts (absolute paths) the operator explicitly
   * allows. Never widened implicitly.
   */
  readonly extraReadOnlyMounts?: readonly string[];
}

export interface SandboxedCommand {
  readonly wrapped: true;
  /** Final argv to exec. First element is the sandbox binary. */
  readonly argv: readonly string[];
  /** Summary for logs/UI. Names the mechanism and the confinement shape. */
  readonly summary: string;
}

export interface SandboxUnavailable {
  readonly wrapped: false;
  readonly availability: SandboxAvailability;
}

export type SandboxWrapResult = SandboxedCommand | SandboxUnavailable;

/**
 * Capability probe. Production uses `probeHostCapabilities`; tests inject a
 * fake. Returns the availability record without performing any sandboxed exec.
 */
export type CapabilityProbe = (platform: SandboxPlatform) => SandboxAvailability;

/**
 * Detect the sandbox profile for this host. Never throws. Honest about
 * unavailability — callers can rely on `kind` to decide posture.
 */
export function detectSandbox(
  options: SandboxProfileOptions = {},
  probe: CapabilityProbe = probeHostCapabilities
): SandboxAvailability {
  const platform = currentPlatform();
  if (options.enabled !== true) {
    return {
      kind: "disabled",
      platform,
      reason: "Sandbox profile is disabled by default; pass enabled: true to opt in."
    };
  }
  return probe(platform);
}

/**
 * Build a sandboxed argv for `command`, or return a structured unavailable.
 * Never silently falls through to unsandboxed execution: if the profile is
 * not available the result is `SandboxUnavailable` and the CALLER decides
 * whether to refuse the run or ask the operator.
 *
 * Confinement shape (when wrapped):
 *   - workspace root is the ONLY writable mount
 *   - /usr, /lib, /lib64, /bin, /sbin are bound read-only so the toolchain works
 *   - /etc/resolv.conf, /etc/hosts, /etc/ssl are bound read-only for the toolchain
 *   - network is UNSHARED by default; pass `allowNetwork: true` to keep it
 *   - no new privileges, dies with parent
 */
export function buildSandboxedCommand(
  command: readonly string[],
  options: SandboxProfileOptions = {},
  probe: CapabilityProbe = probeHostCapabilities
): SandboxWrapResult {
  const availability = detectSandbox(options, probe);
  if (availability.kind !== "available") {
    return { wrapped: false, availability };
  }
  const workspaceRoot = options.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0 || !isAbsolute(workspaceRoot)) {
    return {
      wrapped: false,
      availability: {
        kind: "missing-binary",
        platform: availability.platform,
        reason: "Sandbox is enabled but no absolute workspaceRoot was provided; refusing to wrap."
      }
    };
  }
  if (command.length === 0) {
    return {
      wrapped: false,
      availability: {
        kind: "missing-binary",
        platform: availability.platform,
        reason: "Sandbox is enabled but the command argv is empty; refusing to wrap."
      }
    };
  }
  const argv = buildBwrapArgv(command, {
    workspaceRoot: resolve(workspaceRoot),
    allowNetwork: options.allowNetwork === true,
    extraReadOnlyMounts: options.extraReadOnlyMounts ?? []
  });
  return {
    wrapped: true,
    argv,
    summary:
      `bwrap: writes confined to workspace; network ${options.allowNetwork === true ? "allowed (explicit opt-in)" : "disabled (default)"}; ` +
      `${(options.extraReadOnlyMounts ?? []).length} extra read-only mount(s).`
  };
}

/**
 * Production probe. Linux ⇒ bubblewrap when the binary is resolvable on PATH.
 * Other OSes report unsupported-platform honestly. Never throws.
 *
 * The PATH lookup is injected so tests can run without `which`/`where` and
 * without root.
 */
export function probeHostCapabilities(
  platform: SandboxPlatform,
  lookupBinary: (name: string) => boolean = defaultLookupBinary
): SandboxAvailability {
  if (platform !== "linux") {
    return {
      kind: "unsupported-platform",
      platform,
      reason:
        platform === "darwin"
          ? "macOS Seatbelt profile is not implemented in v1 (plan exclusion)."
          : platform === "win32"
            ? "Windows AppContainer profile is not implemented in v1 (plan exclusion)."
            : "Host OS has no sandbox profile implementation in v1."
    };
  }
  if (!lookupBinary("bwrap")) {
    return {
      kind: "missing-binary",
      platform,
      reason: "bubblewrap (bwrap) was not found on PATH; install bubblewrap to enable the OS sandbox profile."
    };
  }
  return {
    kind: "available",
    platform,
    binary: "bwrap",
    reason: "bubblewrap detected; workspace writes confined, network disabled by default."
  };
}

/** Visible for tests: classify `process.platform` into the profile's platform union. */
export function currentPlatform(value: NodeJS.Platform = process.platform): SandboxPlatform {
  if (value === "linux") return "linux";
  if (value === "darwin") return "darwin";
  if (value === "win32") return "win32";
  return "other";
}

/** Default PATH probe. Synchronous and cheap; never throws. */
function defaultLookupBinary(name: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const pathExt = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const separator = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(separator)) {
    if (dir.length === 0) continue;
    for (const ext of pathExt) {
      try {
        // accessSync with X_OK: presence + executable. No shell-out.
        accessSync(`${dir}/${name}${ext}`, constants.X_OK);
        return true;
      } catch {
        // keep scanning
      }
    }
  }
  return false;
}

interface BwrapShape {
  readonly workspaceRoot: string;
  readonly allowNetwork: boolean;
  readonly extraReadOnlyMounts: readonly string[];
}

/**
 * Assemble the bubblewrap argv. Pure function — no I/O, no PATH lookup, no
 * exec. Kept separate so tests can assert the exact confinement shape without
 * a Linux host or root.
 */
export function buildBwrapArgv(command: readonly string[], shape: BwrapShape): readonly string[] {
  const argv: string[] = ["bwrap"];
  // Die with parent, no setuid, no new capabilities.
  argv.push("--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-cgroup");
  if (!shape.allowNetwork) {
    argv.push("--unshare-net");
  }
  // Minimal root: bind system toolchain read-only so ordinary commands work.
  for (const sys of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) {
    argv.push("--ro-bind", sys, sys);
  }
  // TLS / DNS config so TLS-verified CLIs still work when network IS opted in.
  for (const etc of ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl", "/etc/ca-certificates"]) {
    argv.push("--ro-bind-try", etc, etc);
  }
  // Workspace root is the ONLY writable mount.
  argv.push("--bind", shape.workspaceRoot, shape.workspaceRoot);
  argv.push("--chdir", shape.workspaceRoot);
  // Explicit extra read-only mounts (operator-chosen, never widened implicitly).
  for (const mount of shape.extraReadOnlyMounts) {
    if (isAbsolute(mount)) {
      argv.push("--ro-bind", mount, mount);
    }
  }
  // Fresh /tmp so a sandboxed process cannot poke at host tmp state.
  argv.push("--tmpfs", "/tmp");
  argv.push("--", ...command);
  return argv;
}
