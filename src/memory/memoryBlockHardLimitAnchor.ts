const RESERVED_BLOCK_INDEX = 0;

/**
 * Ensure the reserved memory block still carries the required hard-limit text.
 * If the text is already present anywhere, preserve the existing block order.
 * Otherwise restore the anchor by inserting a dedicated reserved block first.
 */
export function ensureAnchor(blocks: readonly string[], requiredText: string): readonly string[] {
  const anchor = requiredText.trim();
  if (anchor.length === 0) {
    return blocks;
  }
  if (blocks.some((block) => block.includes(anchor))) {
    return blocks;
  }
  return [anchor, ...blocks.slice(RESERVED_BLOCK_INDEX)];
}
