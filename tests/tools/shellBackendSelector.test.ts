import { describe, expect, it } from "vitest";

import { selectShellBackend } from '../../src/tools/shellBackendSelector.js';

describe("selectShellBackend", () => {
  it("returns the policy-named backend when it is available", () => {
    expect(selectShellBackend("bash", ["sh", "bash", "powershell"])).toBe("bash");
  });

  it("falls back to the first available backend when the policy name is missing", () => {
    expect(selectShellBackend("bash", ["sh", "powershell"])).toBe("sh");
  });

  it("returns undefined when no backend is available", () => {
    expect(selectShellBackend("bash", [])).toBeUndefined();
  });
});
