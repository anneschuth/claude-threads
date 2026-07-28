/**
 * Pure parsing of the "reply to me in this thread" directive.
 *
 * Deliberately requires BOTH a directive and a URL: agents paste permalinks
 * for reference all the time ("see the discussion at <url>"), and treating
 * every link as a reply-to address would spray answers into unrelated threads.
 */

/**
 * Phrases that mean "send your answer to the thread this link points at".
 * Russian first — that's what the fleet actually speaks.
 *
 * `в тред` covers "отвечай мне в тред", "пиши в тред", "ответ в тред" without
 * enumerating verb forms. The English side needs the verb because a bare
 * "thread" is far too common in technical prose to be a directive.
 */
const REPLY_DIRECTIVE_RE =
  /(в\s+тред)|((reply|respond|answer|report|post)\b[^\n]{0,40}?\bthread)/i;

/** URL run: stops at whitespace and at characters that usually close a link. */
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** Trailing punctuation that is sentence, not URL. */
const TRAILING_PUNCT_RE = /[.,;:!?)»"'`]+$/;

/**
 * Find the permalink the sender wants the answer delivered to.
 *
 * Returns the first URL that appears AFTER a reply directive, which is how
 * these handoffs are always phrased ("… отвечай мне в тред: <url>"). A URL
 * before the directive is reference material, not an address.
 *
 * Returns null when there's no directive, or a directive with no URL after it.
 */
export function findReturnAddressUrl(message: string): string | null {
  if (!message) return null;

  const directive = REPLY_DIRECTIVE_RE.exec(message);
  if (!directive) return null;

  const directiveEnd = directive.index + directive[0].length;

  // Fresh lastIndex per call: URL_RE is a module-level /g regex.
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(message); m !== null; m = URL_RE.exec(message)) {
    if (m.index < directiveEnd) continue;
    const url = m[0].replace(TRAILING_PUNCT_RE, '');
    return url || null;
  }
  return null;
}
