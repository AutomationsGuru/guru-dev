/**
 * Commit Message Preview
 *
 * Produces a safe, reviewable `git commit -m '…'` command string.
 * Never executes git. Intended for human review in a buffer.
 */

export function formatCommitCommand(message: string): string {
  if (!message || message.trim().length === 0) {
    throw new Error("Commit message cannot be empty");
  }

  // POSIX-safe single-quote escaping:
  // Replace ' with '\'' so the outer single quotes remain intact.
  const escaped = message.replace(/'/g, "'\\''");

  return `git commit -m '${escaped}'`;
}
