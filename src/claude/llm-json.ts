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
