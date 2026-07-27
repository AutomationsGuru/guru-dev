/**
 * Session Instincts — extract and select instincts from session transcripts.
 * Pure, fixture-based functions for the memory flywheel (EXTRACT → ... → INJECT).
 */

export interface Instinct {
  id: string;
  text: string;
  confidence: number; // 0–1 inclusive
  sourceSessionId: string;
}

/**
 * Extract structured instincts from a session transcript.
 * Looks for lines of the form: INSTINCT: <text> | confidence: <0-1>
 * Pure function — deterministic output for a given input.
 */
export function extractInstincts(
  transcript: string,
  sourceSessionId: string
): Instinct[] {
  if (!transcript || !sourceSessionId) {
    return [];
  }

  const instincts: Instinct[] = [];
  const lines = transcript.split(/\r?\n/);
  let counter = 0;

  for (const line of lines) {
    // Match: INSTINCT: some text here | confidence: 0.85
    const match = line.match(/^\s*INSTINCT:\s*(.+?)\s*\|\s*confidence:\s*([0-9]*\.?[0-9]+)\s*$/i);
    if (match) {
      const text = match[1].trim();
      const confidence = parseFloat(match[2]);

      // Only accept valid confidence in [0, 1]
      if (!Number.isNaN(confidence) && confidence >= 0 && confidence <= 1 && text.length > 0) {
        instincts.push({
          id: `instinct-${sourceSessionId}-${counter++}`,
          text,
          confidence,
          sourceSessionId
        });
      }
    }
  }

  return instincts;
}

/**
 * Select instincts for injection.
 * Filters by minimum confidence threshold, caps at maxCount, and orders by confidence descending.
 */
export function selectForInject(
  instincts: Instinct[],
  options: { minConfidence?: number; maxCount?: number } = {}
): Instinct[] {
  const { minConfidence = 0, maxCount = Infinity } = options;

  if (!Array.isArray(instincts) || instincts.length === 0) {
    return [];
  }

  const effectiveMin = Math.max(0, Math.min(1, minConfidence ?? 0));
  const effectiveMax = Math.max(0, Math.floor(maxCount ?? Infinity));

  return instincts
    .filter((instinct) => instinct.confidence >= effectiveMin)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, effectiveMax);
}
