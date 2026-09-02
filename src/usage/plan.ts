/**
 * Turning the credential's plan fields into something worth reading.
 *
 * Both come straight out of `.credentials.json` — no extra call. Measured on
 * real seats: `subscriptionType` is the coarse plan ("max"), and
 * `rateLimitTier` carries the multiplier ("default_claude_max_20x"). The
 * multiplier is the part that matters, because "Max" alone doesn't tell you
 * whether a weekly window is four times bigger than the seat next to it.
 */

/** Strip the vendor prefix these tiers are wrapped in. */
const TIER_PREFIX = /^default_claude_/;

function titleCase(text: string): string {
  const spaced = text.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A human label for the plan, or `undefined` when the credential says nothing.
 *
 * Never invents a multiplier: an unrecognised tier degrades to the coarse
 * subscription type, and failing that is shown verbatim. A wrong "20×" would
 * be worse than no badge at all.
 */
export function planLabel(creds: {
  subscriptionType?: string;
  rateLimitTier?: string;
}): string | undefined {
  const tier = creds.rateLimitTier?.trim();

  if (tier) {
    const bare = tier.replace(TIER_PREFIX, '');
    const known = bare.match(/^(max|pro|team|enterprise)(?:_(\d+)x)?$/i);
    if (known) {
      const plan = titleCase(known[1]);
      return known[2] ? `${plan} ${known[2]}×` : plan;
    }

    // Unfamiliar tier. Prefer the coarse type if we have one — it is at least
    // certainly true — otherwise show the tier rather than hiding it.
    if (creds.subscriptionType?.trim()) return titleCase(creds.subscriptionType.trim());
    return titleCase(bare).replace(/(\d+)x\b/i, '$1×');
  }

  return creds.subscriptionType?.trim() ? titleCase(creds.subscriptionType.trim()) : undefined;
}
