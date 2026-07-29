/**
 * Pure parsing of the "reply to me in this thread" directive.
 *
 * Two accepted forms, and the order matters:
 *
 * 1. `reply-to: <url>` — the machine marker. One token, no natural language,
 *    so it survives translation, rewording and an agent's paraphrasing.
 * 2. Prose — "отвечай мне в тред: <url>" / "reply in the thread: <url>".
 *
 * The prose form is what the fleet's prompts still ask agents to write, so it
 * stays understood indefinitely; the marker is what code emits. Teaching the
 * parser both BEFORE anything emits the marker is the whole point — a parser
 * that learns the new form after the old one is gone drops addresses in
 * between, and a dropped address means an answer nobody ever receives.
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

/**
 * The machine marker: `reply-to: <url>`.
 *
 * The lookbehind keeps `no-reply-to:` and similar compounds out. Nothing else
 * is required around it — a leading `↩`, a list bullet or a `---` rule above
 * are all cosmetics the emitter is free to change.
 */
const MACHINE_MARKER_RE = /(?<![\w-])reply-to:\s*(https?:\/\/[^\s<>()[\]"'`]+)/i;

/** URL run: stops at whitespace and at characters that usually close a link. */
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** Trailing punctuation that is sentence, not URL. */
const TRAILING_PUNCT_RE = /[.,;:!?)»"'`]+$/;

/**
 * Marks a message as a delivered ANSWER rather than a request. Such a message
 * carries a link to the answerer's thread as a courtesy — "here is where this
 * came from" — and that link must NOT be read as "deliver your next answer
 * here".
 *
 * Without this, delivery hijacked the requester's session: we post
 * `@bebop <answer> … reply-to: <our thread>` into bebop's thread, bebop's bot is
 * woken by the mention (correct — it should see the answer), captureReturnAddress
 * parses the marker, and bebop's return address now points at OUR thread. The
 * next answer bebop produces for someone else is then delivered to us.
 */
const DELIVERED_ANSWER_RE = /(?<![\w-])delivered-answer(?![\w-])/i;

/**
 * True when THIS message is one of our delivered answers.
 *
 * Only the last non-empty line counts, because that is where the emitter puts the
 * footer. Testing the whole message dropped the return address of any genuine
 * request that quoted a previous delivered answer as context — routine in this
 * fleet — and captureReturnAddress fails silently, so the answer would simply
 * never arrive.
 */
function isDeliveredAnswer(message: string): boolean {
  const lines = message.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const lastLine = lines[lines.length - 1] ?? '';
  return DELIVERED_ANSWER_RE.test(lastLine);
}

/**
 * Render the machine marker. The single place the emitted format is decided —
 * every message code sends goes through here, so the shape can change without
 * hunting call sites, and `MACHINE_MARKER_RE` above is its only contract.
 *
 * The `↩` is for the humans reading the thread; the parser ignores it.
 */
export function buildReturnAddressMarker(url: string): string {
  return `↩ reply-to: ${url}`;
}

/**
 * Footer for a delivered answer: the backlink without the directive. Reply to us
 * through `send_to_teammate`, which resolves the route itself — a raw address
 * here is what caused the hijack above.
 */
export function buildDeliveredAnswerFooter(url: string): string {
  return `↩ delivered-answer · мой тред: ${url}`;
}

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

  // Our own delivered answer: its backlink is provenance, not an address.
  if (isDeliveredAnswer(message)) return null;

  // Marker first: when a message carries both (a bot forwarding a human's
  // prose request, say), the machine form is the one that was written on
  // purpose by code.
  const marker = MACHINE_MARKER_RE.exec(message);
  if (marker) {
    const url = marker[1].replace(TRAILING_PUNCT_RE, '');
    if (url) return url;
  }

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
