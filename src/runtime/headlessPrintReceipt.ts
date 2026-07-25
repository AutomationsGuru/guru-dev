export interface HeadlessPrintResult {
  readonly text: string;
  readonly toolsUsed: readonly string[];
  readonly error?: string;
}

export interface HeadlessPrintReceipt {
  readonly text: string;
  readonly toolsUsed: readonly string[];
  readonly exitHint: string;
}

/** Assemble the stable, script-facing result for a non-interactive run. */
export function assemble(result: HeadlessPrintResult): HeadlessPrintReceipt {
  return {
    text: result.text,
    toolsUsed: [...result.toolsUsed],
    exitHint: result.error === undefined ? "completed" : `error: ${result.error}`
  };
}
