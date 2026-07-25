import { applyHashlineEdit, hashlineContentHash } from '../../src/tools/hashlineEditApply.js';

describe("applyHashlineEdit", () => {
  it("applies a line-range patch with a matching full-content hash", () => {
    const content = "first\nsecond\nthird\n";

    const result = applyHashlineEdit(content, {
      contentHash: hashlineContentHash(content),
      startLine: 2,
      endLine: 2,
      replacement: "updated\ninserted"
    });

    expect(result).toEqual({
      applied: true,
      content: "first\nupdated\ninserted\nthird\n",
      contentHash: hashlineContentHash("first\nupdated\ninserted\nthird\n")
    });
  });

  it("rejects a stale patch and returns the original content unchanged", () => {
    const observedContent = "first\nsecond\nthird\n";
    const currentContent = "first\nchanged elsewhere\nthird\n";

    const result = applyHashlineEdit(currentContent, {
      contentHash: hashlineContentHash(observedContent),
      startLine: 2,
      endLine: 2,
      replacement: "updated"
    });

    expect(result).toEqual({
      applied: false,
      content: currentContent,
      reason: "stale-hash",
      expectedHash: hashlineContentHash(observedContent),
      actualHash: hashlineContentHash(currentContent)
    });
    expect(currentContent).toBe("first\nchanged elsewhere\nthird\n");
  });
});
