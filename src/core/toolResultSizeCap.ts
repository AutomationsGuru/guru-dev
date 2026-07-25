/**
 * Tool result size cap (R-TSIZE-01).
 *
 * Pure function: callers pass the byte budget; this module never reads config
 * and therefore cannot raise a hard limit by configuration alone.
 *
 * Truncation rules:
 * - If text byte length (UTF-8) <= maxBytes, return unchanged.
 * - If exceeds, truncate to fit within maxBytes INCLUDING a marker.
 * - Never split a UTF-8 code point.
 * - Marker format: `\n...[truncated X bytes — tool result size cap Y bytes]`
 */

const MARKER_PREFIX = "\n...[truncated ";
const MARKER_SUFFIX = " bytes — tool result size cap ";
const MARKER_END = " bytes]";

function buildMarker(overBytes: number, cap: number): string {
  return `${MARKER_PREFIX}${overBytes}${MARKER_SUFFIX}${cap}${MARKER_END}`;
}

export function capResult(text: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || Number.isNaN(maxBytes)) {
    throw new Error(`maxBytes must be a non-negative integer (got ${maxBytes})`);
  }

  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes <= maxBytes) {
    return text;
  }

  const marker = buildMarker(textBytes - maxBytes, maxBytes);
  const markerBytes = Buffer.byteLength(marker, "utf8");

  // If even the marker alone exceeds the budget, return as much of the marker as fits
  // without splitting a code point (best-effort: cut at last valid boundary).
  if (markerBytes > maxBytes) {
    // Return a safe prefix of the marker (may be empty string if maxBytes is tiny)
    return truncateToByteLimit(marker, maxBytes);
  }

  const available = maxBytes - markerBytes;

  // Find the largest prefix of text whose byte length <= available
  // without splitting a multi-byte char.
  const truncated = truncateToByteLimit(text, available);

  return truncated + marker;
}

function truncateToByteLimit(input: string, byteLimit: number): string {
  if (byteLimit <= 0) return "";
  let lo = 0;
  let hi = input.length;
  // Binary search for the rightmost code point boundary that fits.
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const slice = input.slice(0, mid);
    if (Buffer.byteLength(slice, "utf8") <= byteLimit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return input.slice(0, lo);
}
