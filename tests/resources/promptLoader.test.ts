import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPromptLoader } from '../../src/resources/promptLoader.js';

describe("promptLoader", () => {
  it("loads templates and snippets correctly", async () => {
    const dir = join(tmpdir(), `guru-prompt-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "t1.md"), [
        "---",
        "id: test-1",
        "name: Test Template",
        "kind: template",
        "variables:",
        "  - name: code",
        "    required: true",
        "---",
        "Hello {{code}}"
      ].join("\n"));
      
      writeFileSync(join(dir, "s1.md"), [
        "---",
        "id: snip-1",
        "kind: snippet",
        "toolId: mcp_call",
        "---",
        "Do the thing."
      ].join("\n"));
      
      const loader = createPromptLoader([dir]);
      const templates = await loader.list();
      expect(templates).toHaveLength(1);
      expect(templates[0]?.id).toBe("test-1");
      expect(templates[0]?.variables).toHaveLength(1);
      
      const snippets = await loader.listSnippets();
      expect(snippets).toHaveLength(1);
      expect(snippets[0]?.id).toBe("snip-1");
      expect(snippets[0]?.toolId).toBe("mcp_call");
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks secret values", async () => {
    const dir = join(tmpdir(), `guru-prompt-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "bad.md"), [
        "---",
        "id: bad-1",
        "---",
        "My token is sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxx-xx"
      ].join("\n"));
      
      const loader = createPromptLoader([dir]);
      const templates = await loader.list();
      expect(templates).toHaveLength(0); // Should be skipped due to secret
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
