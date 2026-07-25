import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PrDraftSchema, type PrDraft } from "./prDraftSchema.js";

function makeTitle(diffSummary: string, notes: string): string {
  const src = (diffSummary || notes || "Update").trim();
  return src.length > 72 ? src.slice(0, 69) + "..." : src;
}

function makeBody(diffSummary: string, notes: string): string {
  return `## Summary\n\n${diffSummary}\n\n## Review Notes\n\n${notes}`;
}

function makeTestPlan(_notes: string): string {
  return "- Run full test suite\n- Manual smoke of changed surfaces\n- Verify no regressions in delivery path";
}

export function buildDraft(diffSummary: string, notes: string): PrDraft {
  const draft = {
    title: makeTitle(diffSummary, notes),
    body: makeBody(diffSummary, notes),
    files: [],
    testPlan: makeTestPlan(notes)
  };
  return PrDraftSchema.parse(draft);
}

export function writeDraft(draft: PrDraft): string {
  const dir = join(process.cwd(), ".guru", "drafts");
  mkdirSync(dir, { recursive: true });
  const slug = draft.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "pr";
  const file = `pr-draft-${slug}-${Date.now()}.md`;
  const outPath = join(dir, file);
  const md = `# ${draft.title}\n\n${draft.body}\n\n## Test Plan\n\n${draft.testPlan}\n\n**Files changed:** ${draft.files.length ? draft.files.join(", ") : "(see diff)"}`;
  writeFileSync(outPath, md + "\n", "utf8");
  return outPath;
}
