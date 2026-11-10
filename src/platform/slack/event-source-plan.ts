/**
 * Plan which configured Slack entries share one Socket Mode connection.
 *
 * Slack round-robins Socket Mode envelopes across all of an app's open
 * connections. Two `platforms:` entries with the same app token that each open
 * a socket therefore lose each other's events, in both channels, silently.
 * The shared event source (#502) fixes that when it's wired up: one parent owns
 * the socket and injects events for other channels into secondaries.
 *
 * Rule: per app token, the first enabled entry is the parent; every other entry
 * on that token (enabled or not) is its secondary. A token with no enabled
 * entry has no parent, and nothing is routed.
 *
 * @returns secondary platform id → parent platform id
 */
export function planSlackEventSources(
  platforms: ReadonlyArray<{ id: string; type: string; appToken?: string }>,
  isEnabled: (id: string) => boolean,
): Map<string, string> {
  const parentByToken = new Map<string, string>();
  for (const p of platforms) {
    if (p.type === 'slack' && p.appToken && isEnabled(p.id) && !parentByToken.has(p.appToken)) {
      parentByToken.set(p.appToken, p.id);
    }
  }
  const plan = new Map<string, string>();
  for (const p of platforms) {
    if (p.type !== 'slack' || !p.appToken) continue;
    const parent = parentByToken.get(p.appToken);
    if (parent && parent !== p.id) plan.set(p.id, parent);
  }
  return plan;
}
