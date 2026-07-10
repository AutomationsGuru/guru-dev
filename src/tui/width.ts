/**
 * Shared display-width utilities for the terminal TUI.
 *
 * All width math in the harness is in DISPLAY cells (CJK/emoji = 2, combining
 * marks = 0), not UTF-16 code units. This module is the single source of truth
 * — previously `components.ts` and `editor.ts` each had a private copy of
 * `charDisplayWidth`, which was an intentional workaround for a circular-import
 * hazard that no longer exists (2026-07-09 audit).
 */

/**
 * East-Asian-Width Wide code points OUTSIDE the contiguous CJK blocks below —
 * the BMP emoji-presentation symbols (⌚⏰☕⚡✅❌⭐⭕ …) plus the supplementary
 * enclosed/squared blocks before U+1F300. Terminals (Windows Terminal, xterm,
 * kitty) render these 2 cells; counting them 1 made every width computation
 * (status-bar gap, wrap math, overlay clamp) overflow by one cell per symbol —
 * the default '⚡YOLO' status chip alone pushed the pinned bar to full width
 * and resurrected the per-keystroke xenl frame-stacking bug v1.4.1 fixed.
 */
const WIDE_SYMBOL_RANGES: readonly (readonly [number, number])[] = [
  [0x231a, 0x231b], // watch, hourglass
  [0x2329, 0x232a], // angle brackets
  [0x23e9, 0x23ec], // media arrows
  [0x23f0, 0x23f0], // alarm clock
  [0x23f3, 0x23f3], // hourglass flowing
  [0x25fd, 0x25fe], // small squares
  [0x2614, 0x2615], // umbrella, hot beverage
  [0x2648, 0x2653], // zodiac
  [0x267f, 0x267f], // wheelchair
  [0x2693, 0x2693], // anchor
  [0x26a1, 0x26a1], // high voltage (the YOLO chip)
  [0x26aa, 0x26ab], // circles
  [0x26bd, 0x26be], // soccer, baseball
  [0x26c4, 0x26c5], // snowman, sun behind cloud
  [0x26ce, 0x26ce], // ophiuchus
  [0x26d4, 0x26d4], // no entry
  [0x26ea, 0x26ea], // church
  [0x26f2, 0x26f3], // fountain, golf flag
  [0x26f5, 0x26f5], // sailboat
  [0x26fa, 0x26fa], // tent
  [0x26fd, 0x26fd], // fuel pump
  [0x2705, 0x2705], // check mark button
  [0x270a, 0x270b], // fists
  [0x2728, 0x2728], // sparkles
  [0x274c, 0x274c], // cross mark
  [0x274e, 0x274e], // negative cross
  [0x2753, 0x2755], // question/exclamation ornaments
  [0x2757, 0x2757], // heavy exclamation
  [0x2795, 0x2797], // plus/minus/divide
  [0x27b0, 0x27b0], // curly loop
  [0x27bf, 0x27bf], // double curly loop
  [0x2b1b, 0x2b1c], // large squares
  [0x2b50, 0x2b50], // star
  [0x2b55, 0x2b55], // heavy circle
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // joker
  [0x1f18e, 0x1f18e], // AB button
  [0x1f191, 0x1f19a], // squared CL…VS
  [0x1f200, 0x1f202], // squared hiragana/katakana
  [0x1f210, 0x1f23b], // squared CJK ideographs
  [0x1f240, 0x1f248], // tortoise-shell CJK
  [0x1f250, 0x1f251] // circled ideographs
];

function isWideSymbol(codePoint: number): boolean {
  if (codePoint < 0x231a || codePoint > 0x1f251) {
    return false;
  }
  for (const [low, high] of WIDE_SYMBOL_RANGES) {
    if (codePoint >= low && codePoint <= high) {
      return true;
    }
  }
  return false;
}

/** Display width of one code point: 0 for combining/zero-width, 2 for wide (CJK/emoji), else 1. */
export function charDisplayWidth(codePoint: number): number {
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // combining diacritics
    (codePoint >= 0x200b && codePoint <= 0x200f) || // zero-width space/joiners/marks
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    codePoint === 0xfeff // zero-width no-break space (BOM)
  ) {
    return 0; // composed text measures as its base char
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals … Yi
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compat forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji blocks
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) || // CJK ext B+
    isWideSymbol(codePoint) // EAW-Wide BMP symbols (⚡✅❌⭐…) + enclosed blocks
  ) {
    return 2;
  }
  return 1;
}
