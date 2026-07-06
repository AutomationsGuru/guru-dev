import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openVault } from "../../src/safety/vault.js";

let n = 0;
const homes: string[] = [];
function freshHome(): string {
  const home = join(tmpdir(), `guru-vault-${process.pid}-${n++}`);
  homes.push(home);
  mkdirSync(home, { recursive: true });
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const SECRET = "sk-ant-api03-THIS-IS-A-TEST-VALUE-abcdefghijklmnop";

describe("credential vault — encrypted at rest, names-only listing", () => {
  it("round-trips a value across open/save/re-open (keyfile mode, auto-unlock)", () => {
    const home = freshHome();
    const v1 = openVault({ home });
    expect(v1.size).toBe(0); // empty when absent
    expect(v1.kdf).toBe("keyfile");
    v1.set("ANTHROPIC_API_KEY", SECRET);
    v1.save();

    const v2 = openVault({ home }); // fresh instance, no passphrase — auto-unlocks via the key file
    expect(v2.get("ANTHROPIC_API_KEY")).toBe(SECRET);
    expect(v2.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(v2.names()).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("stores CIPHERTEXT — the plaintext secret never appears in the vault file", () => {
    const home = freshHome();
    const v = openVault({ home });
    v.set("ANTHROPIC_API_KEY", SECRET);
    v.save();
    const raw = readFileSync(v.filePath, "utf8");
    expect(raw).not.toContain(SECRET); // encrypted at rest
    expect(raw).not.toContain("sk-ant"); // not even a prefix leaks
    // The machine key file exists (0600 in POSIX; best-effort on Windows).
    expect(existsSync(join(home, ".guruharness", "vault.key"))).toBe(true);
  });

  it("names() lists KEYS only — values are never returned by the listing surface", () => {
    const home = freshHome();
    const v = openVault({ home });
    v.set("OPENAI_API_KEY", "sk-openai-x");
    v.set("ANTHROPIC_API_KEY", SECRET);
    v.save();
    expect(v.names()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]); // sorted names
    expect(JSON.stringify(v.names())).not.toContain(SECRET);
  });

  it("a passphrase-derived vault cannot be opened with the wrong passphrase (GCM auth fails)", () => {
    const home = freshHome();
    const v = openVault({ home, passphrase: "correct horse" });
    expect(v.kdf).toBe("scrypt");
    v.set("ANTHROPIC_API_KEY", SECRET);
    v.save();

    expect(openVault({ home, passphrase: "correct horse" }).get("ANTHROPIC_API_KEY")).toBe(SECRET);
    expect(() => openVault({ home, passphrase: "wrong passphrase" }).get("ANTHROPIC_API_KEY")).toThrow(); // tamper/mis-key surfaces, never silent-empty
  });

  it("remove deletes a key; save persists the deletion", () => {
    const home = freshHome();
    const v = openVault({ home });
    v.set("A_KEY", "1");
    v.set("B_KEY", "2");
    v.save();
    const v2 = openVault({ home });
    expect(v2.remove("A_KEY")).toBe(true);
    expect(v2.remove("A_KEY")).toBe(false); // already gone
    v2.save();
    expect(openVault({ home }).names()).toEqual(["B_KEY"]);
  });

  it("GURU_VAULT_PASSPHRASE from env selects scrypt mode automatically", () => {
    const home = freshHome();
    const v = openVault({ home, env: { GURU_VAULT_PASSPHRASE: "from-env" } as NodeJS.ProcessEnv });
    expect(v.kdf).toBe("scrypt");
    v.set("X_KEY", "x");
    v.save();
    expect(openVault({ home, env: { GURU_VAULT_PASSPHRASE: "from-env" } as NodeJS.ProcessEnv }).get("X_KEY")).toBe("x");
  });
});
