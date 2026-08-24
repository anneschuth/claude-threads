/**
 * Natural-language watch parsing: "!watch when someone reports a production
 * incident, triage it and post a checklist" → a validated watch definition
 * with prefilter keywords.
 *
 * One haiku pass (quickQuery) produces strict JSON; everything it returns is
 * re-validated here, so the model can never smuggle invalid fields into the
 * store. Nothing is saved without the human confirming the parsed result —
 * including the derived keywords, which the confirmation card displays so
 * the creator can veto a prefilter that would miss or over-match.
 */

import { parseJsonViaHaiku } from '../claude/llm-json.js';
import { validateKeywords } from '../persistence/watches-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('watches');

// Watch parses run noticeably longer than routine parses (the model derives
// a condition, a task AND up to 10 synonym-covering keywords) — 15s times
// out on real prompts (measured ~15.0s raw CLI time). Creation is a one-off
// interactive step behind a "Parsing the trigger..." post, so a generous
// budget beats a flaky one.
const PARSE_TIMEOUT_MS = 30000;

export interface ParsedWatchRequest {
  name: string;
  condition: string;
  prompt: string;
  keywords: string[];
}

export type ParseWatchResult =
  | { ok: true; parsed: ParsedWatchRequest }
  | { ok: false; error: string };

export function buildWatchParsePrompt(request: string): string {
  return `Parse this event-trigger ("watch") request from a chat user into JSON.

Request: ${request}

A watch fires a task whenever a matching message appears in the channel. Output ONLY a JSON object, no other text, with exactly these fields:
- "name": short descriptive name for the watch (max 6 words)
- "condition": the matching condition as one clear sentence describing which messages should trigger (e.g. "someone reports a production incident or outage")
- "prompt": the task to perform when triggered, as an instruction (everything that is not the condition)
- "keywords": 4-10 lowercase prefilter terms. Cover paraphrases: include synonyms, word-stem variants, and common informal phrasings a matching message might actually use (e.g. for incidents: "incident", "outage", "down", "broken", "500"). If the request is written in another language, include keywords in BOTH that language and English. Prefer distinctive terms over generic ones ("deploy" is good; "the" is useless).

If the request is not actually asking to watch for future messages, output exactly: {"error": "reason"}`;
}

/**
 * Validate raw parsed fields into a ParsedWatchRequest. Pure — exported so
 * tests can exercise the validation matrix without an LLM call.
 */
export function validateParsedWatch(raw: Record<string, unknown>): ParseWatchResult {
  if (typeof raw.error === 'string' && raw.error) {
    return { ok: false, error: raw.error };
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const condition = typeof raw.condition === 'string' ? raw.condition.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!name || !condition || !prompt) {
    return { ok: false, error: 'could not extract a name, condition and task from the request' };
  }
  const keywords = validateKeywords(raw.keywords);
  if (typeof keywords === 'string') {
    return { ok: false, error: keywords };
  }
  return { ok: true, parsed: { name, condition, prompt, keywords } };
}

/** Parse a natural-language watch request via one haiku call. Never throws. */
export function parseWatchRequest(request: string): Promise<ParseWatchResult> {
  return parseJsonViaHaiku({
    prompt: buildWatchParsePrompt(request),
    timeoutMs: PARSE_TIMEOUT_MS,
    logDebug: (m) => log.debug(`Watch parse: ${m}`),
    unusableMessage: 'the parsing model returned an unusable answer — try rephrasing',
    validate: validateParsedWatch,
  });
}
