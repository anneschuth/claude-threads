/**
 * Shared helper for parsing strict-JSON answers out of LLM output.
 * Used by every quickQuery caller that asks the model for a JSON object
 * (routine parse, watch parse, watch match confirmation).
 */

/**
 * Extract the first JSON object from model output (tolerates chatter or code
 * fences around it). Returns undefined when nothing parses.
 */
export function extractJsonObject(output: string): Record<string, unknown> | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shared shell of every haiku one-shot parser: run the prompt, fail
 * closed on transport errors with a user-postable message, extract the
 * strict-JSON object, and hand it to the caller's validator. Timeouts stay
 * per-caller — routine and watch parses have measured, documented budgets.
 */
export async function parseJsonViaHaiku<T>(opts: {
  prompt: string;
  timeoutMs: number;
  /** Debug-log sink for transport/extraction failures. */
  logDebug(message: string): void;
  /** User-postable message for unusable (non-JSON) model output. */
  unusableMessage: string;
  validate(raw: Record<string, unknown>): T | { ok: false; error: string };
}): Promise<T | { ok: false; error: string }> {
  const { quickQuery } = await import('./quick-query.js');
  const result = await quickQuery({ prompt: opts.prompt, model: 'haiku', timeout: opts.timeoutMs });
  if (!result.success || !result.response) {
    opts.logDebug(`haiku parse failed: ${result.error ?? 'no response'}`);
    return { ok: false, error: 'could not reach the parsing model — try again in a moment' };
  }
  const raw = extractJsonObject(result.response);
  if (!raw) {
    opts.logDebug(`haiku parse returned no JSON object: ${result.response.slice(0, 200)}`);
    return { ok: false, error: opts.unusableMessage };
  }
  return opts.validate(raw);
}
