/**
 * Session-start context cap utility.
 * Truncates injected context to maxChars with ellipsis marker when exceeded.
 */

/**
 * Truncate text to maxChars with ellipsis marker if it exceeds the limit.
 *
 * @param text - The input text to potentially truncate
 * @param maxChars - Maximum allowed character count
 * @returns The original text if within limit, or truncated text with "..." suffix
 */
export function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + '...';
}
