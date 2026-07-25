import { formatCommitCommand } from '../../src/git/commitMessagePreview.js';

describe("formatCommitCommand", () => {
  it("formats a simple message", () => {
    expect(formatCommitCommand("fix: update README")).toBe(
      "git commit -m 'fix: update README'"
    );
  });

  it("formats a multiline message", () => {
    const msg = "feat: add preview\n\nAdds safe commit message formatting.";
    expect(formatCommitCommand(msg)).toBe(
      "git commit -m 'feat: add preview\n\nAdds safe commit message formatting.'"
    );
  });

  it("escapes single quotes safely", () => {
    expect(formatCommitCommand("it's working")).toBe(
      "git commit -m 'it'\\''s working'"
    );
  });

  it("escapes double quotes without breaking outer quotes", () => {
    expect(formatCommitCommand('say "hello"')).toBe(
      "git commit -m 'say \"hello\"'"
    );
  });

  it("rejects empty message", () => {
    expect(() => formatCommitCommand("")).toThrow("Commit message cannot be empty");
    expect(() => formatCommitCommand("   \n\t")).toThrow("Commit message cannot be empty");
  });
});
