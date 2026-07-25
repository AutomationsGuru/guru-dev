import { describe, expect, it } from "vitest";

import { isProtected } from "../../src/mandates/protectedPathBlocklist.js";

describe("isProtected", () => {
  it("protects SSH paths", () => {
    expect(isProtected("~/.ssh")).toBe(true);
    expect(isProtected("/home/operator/.ssh/id_ed25519")).toBe(true);
    expect(isProtected("C:\\Users\\operator\\.ssh\\id_ed25519")).toBe(true);
  });

  it("does not protect ordinary temporary paths", () => {
    expect(isProtected("/tmp")).toBe(false);
    expect(isProtected("/tmp/.ssh-backup")).toBe(false);
  });

  it("evaluates the normalized target rather than a traversed segment", () => {
    expect(isProtected("/tmp/.ssh/../output")).toBe(false);
  });
});
