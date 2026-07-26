/**
 * conflictHandleResolve.ts
 *
 * Pure, non-mutating side selection for merge conflict resolution.
 * Does not write, delete, overwrite, discard, or alter conflict inputs.
 * Only selects and returns the chosen side's content.
 *
 * Supports:
 * - Standard 2-way conflicts (<<<<<<< / ======= / >>>>>>>)
 * - 3-way conflicts with base (<<<<<<< / |||||| / ======= / >>>>>>>)
 *
 * Side options: 'left' | 'right' | 'base' | 'ours' | 'theirs'
 * Aliases: left=ours, right=theirs
 */

export type ConflictSide = 'left' | 'right' | 'base' | 'ours' | 'theirs';

/**
 * Resolve conflicts in content by selecting one side.
 * Pure function: returns new string, original input untouched.
 */
export function conflictHandleResolve(
  content: string,
  side: ConflictSide = 'left'
): string {
  if (typeof content !== 'string') {
    throw new TypeError('content must be a string');
  }
  const validSides: ConflictSide[] = ['left', 'right', 'base', 'ours', 'theirs'];
  if (!validSides.includes(side)) {
    throw new TypeError(`invalid side: ${side}`);
  }

  const lines = content.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('<<<<<<<')) {
      // Enter conflict hunk
      const leftLines: string[] = [];
      i++;
      // Collect left (ours) until base marker or separator
      while (
        i < lines.length &&
        !lines[i].startsWith('||||||') &&
        !lines[i].startsWith('=======')
      ) {
        leftLines.push(lines[i]);
        i++;
      }

      let baseLines: string[] = [];
      if (i < lines.length && lines[i].startsWith('||||||')) {
        i++; // skip base marker
        while (i < lines.length && !lines[i].startsWith('=======')) {
          baseLines.push(lines[i]);
          i++;
        }
      }

      const rightLines: string[] = [];
      if (i < lines.length && lines[i].startsWith('=======')) {
        i++; // skip separator
        while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
          rightLines.push(lines[i]);
          i++;
        }
      }

      // Skip closing marker
      if (i < lines.length && lines[i].startsWith('>>>>>>>')) {
        i++;
      }

      // Select side (pure selection, no mutation)
      let chosen: string[];
      switch (side) {
        case 'left':
        case 'ours':
          chosen = leftLines;
          break;
        case 'right':
        case 'theirs':
          chosen = rightLines;
          break;
        case 'base':
          chosen = baseLines;
          break;
        default:
          chosen = leftLines;
      }

      result.push(...chosen);
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}
