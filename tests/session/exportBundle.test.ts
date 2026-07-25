import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearRegisteredSecretValues, registerSecretValue } from "../../src/safety/secretSafety.js";
import { buildSessionExport, writeSessionExport } from "../../src/session/exportBundle.js";

const RECORD = {
  id: "session-123",
  title: "Refactor the parser",
  routeId: "openai/gpt-5",
  modelIdOverride: null,
  messages: [
    { role: "user" as const, content: "please refactor src/parser.ts" },
    { role: "assistant" as const, content: "done — extracted the tokenizer" }
  ],
  turnCount: 1,
  createdAt: "2026-07-18T10:00:00.000Z",
  updatedAt: "2026-07-18T10:05:00.000Z"
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guru-export-"));
  clearRegisteredSecretValues();
});

afterEach(() => {
  clearRegisteredSecretValues();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildSessionExport", () => {
  it("builds a JSON bundle with metadata and messages", () => {
    const bundle = buildSessionExport(RECORD, { format: "json" });
    expect(bundle.format).toBe("json");
    const parsed = JSON.parse(bundle.contents) as {
      id: string;
      title: string;
      routeId: string;
      messages: Array<{ role: string; content: string }>;
      exportedBy: string;
    };
    expect(parsed.id).toBe("session-123");
    expect(parsed.title).toBe("Refactor the parser");
    expect(parsed.routeId).toBe("openai/gpt-5");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.exportedBy).toBe("GuruHarness");
    expect(bundle.suggestedFileName).toMatch(/session-123.*\.json$/);
  });

  it("builds a markdown bundle with role headings", () => {
    const bundle = buildSessionExport(RECORD, { format: "markdown" });
    expect(bundle.format).toBe("markdown");
    expect(bundle.contents).toContain("# Refactor the parser");
    expect(bundle.contents).toContain("## user");
    expect(bundle.contents).toContain("please refactor src/parser.ts");
    expect(bundle.contents).toContain("## assistant");
    expect(bundle.suggestedFileName).toMatch(/\.md$/);
  });

  it("scrubs token-shaped secrets from exported content (structural choke point)", () => {
    const dirty = {
      ...RECORD,
      messages: [{ role: "user" as const, content: "use key sk-ant-abcdefghijklmnop1234567890 please" }]
    };
    const bundle = buildSessionExport(dirty, { format: "json" });
    expect(bundle.contents).not.toContain("sk-ant-abcdefghijklmnop1234567890");
    expect(bundle.contents).toContain("[redacted");
    expect(bundle.scrubbed).toBe(true);
  });

  it("scrubs registered resolved credential values from exported content", () => {
    registerSecretValue("hunter2-super-secret-password");
    const dirty = {
      ...RECORD,
      title: "login uses hunter2-super-secret-password",
      messages: [{ role: "user" as const, content: "the password is hunter2-super-secret-password" }]
    };
    const bundle = buildSessionExport(dirty, { format: "markdown" });
    expect(bundle.contents).not.toContain("hunter2-super-secret-password");
    expect(bundle.scrubbed).toBe(true);
  });

  it("scrubs secret-word assignments (PASSWORD=...) keeping the key visible", () => {
    const dirty = {
      ...RECORD,
      messages: [{ role: "assistant" as const, content: "set DB_PASSWORD=abc123xyz in .env" }]
    };
    const bundle = buildSessionExport(dirty, { format: "markdown" });
    expect(bundle.contents).toContain("DB_PASSWORD=");
    expect(bundle.contents).not.toContain("abc123xyz");
  });

  it("reports scrubbed=false when nothing needed redaction", () => {
    const bundle = buildSessionExport(RECORD, { format: "json" });
    expect(bundle.scrubbed).toBe(false);
  });

  it("has no cloud/remote field — export is local-only by construction", () => {
    const bundle = buildSessionExport(RECORD, { format: "json" });
    expect(bundle).not.toHaveProperty("remoteUrl");
    expect(bundle).not.toHaveProperty("upload");
    expect(bundle).not.toHaveProperty("shareUrl");
  });
});

describe("writeSessionExport", () => {
  it("writes the bundle to a local directory and returns the absolute path", () => {
    const bundle = buildSessionExport(RECORD, { format: "markdown" });
    const result = writeSessionExport(bundle, { directory: dir });
    expect(result.filePath.startsWith(dir)).toBe(true);
    const written = readFileSync(result.filePath, "utf8");
    expect(written).toBe(bundle.contents);
  });

  it("refuses to overwrite an existing export file", () => {
    const bundle = buildSessionExport(RECORD, { format: "json" });
    writeSessionExport(bundle, { directory: dir });
    expect(() => writeSessionExport(bundle, { directory: dir })).toThrow(/exists|overwrite/i);
  });

  it("keeps the export inside the target directory (no path escape via session id)", () => {
    const dirty = { ...RECORD, id: "../../etc/evil" };
    const bundle = buildSessionExport(dirty, { format: "json" });
    const result = writeSessionExport(bundle, { directory: dir });
    expect(result.filePath.startsWith(dir)).toBe(true);
    expect(result.filePath).not.toContain("..");
  });
});
