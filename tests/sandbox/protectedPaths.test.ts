import { describe, expect, it } from "vitest";

import {
  checkWrite,
  defaultProtectedPrefixes,
  isProtected
} from '../../src/sandbox/protectedPaths.js';

describe("defaultProtectedPrefixes", () => {
  it("includes .git/, .guru/, and home-profile vault/secrets prefixes", () => {
    const defaults = defaultProtectedPrefixes();

    expect(defaults).toContain(".git/");
    expect(defaults).toContain(".guru/");
    expect(defaults.some((prefix) => prefix.includes(".guruharness/vault/"))).toBe(true);
    expect(defaults.some((prefix) => prefix.includes(".guruharness/secrets/"))).toBe(true);
  });
});

describe("isProtected", () => {
  it("matches a top-level .git/config under the workspace root", () => {
    expect(isProtected("/repo/.git/config", "/repo")).toBe(true);
  });

  it("matches nested paths under .git/ (e.g. objects/abc)", () => {
    expect(isProtected("/repo/.git/objects/abc", "/repo")).toBe(true);
  });

  it("does not match an ordinary source file", () => {
    expect(isProtected("/repo/src/foo.ts", "/repo")).toBe(false);
  });

  it("does NOT match myrepo.git/config — the .git prefix is anchored to a top-level segment", () => {
    expect(isProtected("/repo/myrepo.git/config", "/repo")).toBe(false);
  });

  it("matches the project agent config dir (.guru/memory/x.md)", () => {
    expect(isProtected("/repo/.guru/memory/x.md", "/repo")).toBe(true);
  });

  it("matches an absolute home-profile vault path when homeDir is supplied", () => {
    expect(
      isProtected("/home/op/.guruharness/vault/key.pem", "/repo", { homeDir: "/home/op" })
    ).toBe(true);
  });

  it("does not match a vendor-nested .git (only top-level .git is in defaults)", () => {
    expect(isProtected("/repo/vendor/.git/HEAD", "/repo")).toBe(false);
  });

  it("honors opts.extraPrefixes — adds them to the matching set", () => {
    expect(
      isProtected("/repo/artifacts/private/secret.bin", "/repo", {
        extraPrefixes: ["artifacts/private/"]
      })
    ).toBe(true);
  });

  it("treats extraPrefixes as anchored — artifacts/public/ does not match artifacts/private/", () => {
    expect(
      isProtected("/repo/artifacts/public/secret.bin", "/repo", {
        extraPrefixes: ["artifacts/private/"]
      })
    ).toBe(false);
  });

  it("normalizes Windows backslashes before comparing", () => {
    expect(isProtected(String.raw`\repo\.git\config`, "/repo")).toBe(true);
  });

  it("tolerates trailing slashes in opts.extraPrefixes (equivalent to no trailing slash)", () => {
    // Trailing slash is treated identically to the bare prefix.
    expect(
      isProtected("/repo/artifacts/x.bin", "/repo", {
        extraPrefixes: ["artifacts/"]
      })
    ).toBe(isProtected("/repo/artifacts/x.bin", "/repo", { extraPrefixes: ["artifacts"] }));

    expect(
      isProtected("/repo/artifacts/x.bin", "/repo", {
        extraPrefixes: ["artifacts/"]
      })
    ).toBe(true);

    expect(
      isProtected("/repo/artifacts/x.bin", "/repo", {
        extraPrefixes: ["artifacts"]
      })
    ).toBe(true);
  });

  it("does not break with empty extraPrefixes and no homeDir", () => {
    expect(isProtected("/repo/.git/config", "/repo", { extraPrefixes: [] })).toBe(true);
    expect(isProtected("/repo/src/foo.ts", "/repo", { extraPrefixes: [] })).toBe(false);
  });

  it("when workspaceRoot is omitted, relative prefixes cannot match but absolute home ones can", () => {
    expect(isProtected("/repo/.git/config")).toBe(false);
    expect(isProtected("/home/op/.guruharness/vault/key.pem", undefined, { homeDir: "/home/op" })).toBe(true);
  });
});

describe("checkWrite", () => {
  it("returns 'require-elevate' for .git/config", () => {
    expect(checkWrite("/repo/.git/config", "/repo")).toBe("require-elevate");
  });

  it("returns 'allow' for an ordinary source file", () => {
    expect(checkWrite("/repo/src/foo.ts", "/repo")).toBe("allow");
  });

  it("returns 'require-elevate' for .guru/memory/x.md", () => {
    expect(checkWrite("/repo/.guru/memory/x.md", "/repo")).toBe("require-elevate");
  });

  it("returns 'allow' for an unrelated path under the workspace", () => {
    expect(checkWrite("/repo/README.md", "/repo")).toBe("allow");
  });

  it("returns 'require-elevate' for a custom extra prefix match", () => {
    expect(
      checkWrite("/repo/artifacts/private/secret.bin", "/repo", {
        extraPrefixes: ["artifacts/private/"]
      })
    ).toBe("require-elevate");
  });

  it("returns 'require-elevate' for an absolute home-profile vault path", () => {
    expect(
      checkWrite("/home/op/.guruharness/vault/key.pem", "/repo", { homeDir: "/home/op" })
    ).toBe("require-elevate");
  });
});
