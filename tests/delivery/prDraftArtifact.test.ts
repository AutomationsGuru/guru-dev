import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildDraft, writeDraft } from '../../src/delivery/prDraftArtifact.js';
import { PrDraftSchema } from '../../src/delivery/prDraftSchema.js';

const draftsDir = join(process.cwd(), ".guru", "drafts");

describe("prDraftArtifact", () => {
  beforeEach(() => {
    if (existsSync(draftsDir)) rmSync(draftsDir, { recursive: true, force: true });
    mkdirSync(draftsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(draftsDir)) rmSync(draftsDir, { recursive: true, force: true });
  });

  it("buildDraft produces PrDraft from diff summary + notes", () => {
    const draft = buildDraft("diff summary here", "review notes here");
    expect(PrDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.title.length).toBeGreaterThan(0);
    expect(draft.body).toContain("diff summary here");
    expect(draft.testPlan.length).toBeGreaterThan(0);
  });

  it("writeDraft persists markdown under .guru/drafts", () => {
    const draft = buildDraft("sum", "notes");
    const outPath = writeDraft(draft);
    expect(existsSync(outPath)).toBe(true);
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain(draft.title);
    expect(md).toContain("## Summary");
  });

  it("buildDraft and writeDraft perform no network calls", () => {
    const fetchSpy = vi.spyOn(globalThis as any, "fetch").mockResolvedValue({ ok: true } as any);
    const draft = buildDraft("s", "n");
    writeDraft(draft);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
