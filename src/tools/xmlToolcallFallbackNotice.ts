export interface XmlToolcallFallbackNoticeInput {
  readonly usedXmlFallback: boolean;
  readonly alreadyNotified: boolean;
}

/** Returns whether this turn should show the XML tool-call fallback notice. */
export function noticeIfFallback({ usedXmlFallback, alreadyNotified }: XmlToolcallFallbackNoticeInput): boolean {
  return usedXmlFallback && !alreadyNotified;
}
