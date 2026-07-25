import { describe, expect, it } from "vitest";

import { createBox, registerProvider, resolveProvider } from '../../src/sandbox/providerAttachSlot.js';

describe("provider attach slot", () => {
  it("throws for an unknown provider", () => {
    expect(() => resolveProvider("missing")).toThrow("Unknown sandbox provider: missing");
  });

  it("routes createBox through the active registered provider", async () => {
    const calls: string[] = [];
    registerProvider({
      id: "local",
      async createBox() {
        calls.push("local");
        return { id: "box-local" };
      }
    });
    registerProvider({
      id: "remote",
      async createBox() {
        calls.push("remote");
        return { id: "box-remote" };
      }
    });

    expect(resolveProvider("remote").id).toBe("remote");
    await expect(createBox("remote")).resolves.toEqual({ id: "box-remote" });
    expect(calls).toEqual(["remote"]);
  });
});
