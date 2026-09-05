/**
 * Turning the credential's plan fields into something worth reading.
 *
 * Pure: the caller supplies the two fields, `profiles.ts` reads them out of
 * `.claude.json`. Measured on real seats: the coarse plan ("max") and the
 * multiplier tier ("default_claude_max_20x"). The multiplier is the part that
 * matters, because "Max" alone doesn't tell you whether a weekly window is
 * four times bigger than the seat next to it.
 */

/** Strip the vendor prefix these tiers are wrapped in. */
const TIER_PREFIX = /^default_claude_/;

function titleCase(text: string): string {
  const spaced = text.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A human label for the plan, or `undefined` when the metadata says nothing.
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

    // Unfamiliar tier. The coarse type is at least certainly true. With no
    // type there is NO badge: prettifying the raw tier would both invent a
    // multiplier out of a string we did not recognise ("team_premium_20x" is
    // not necessarily 20×) and publish an unvalidated metadata field into a
    // Slack message.
    return creds.subscriptionType?.trim() ? titleCase(creds.subscriptionType.trim()) : undefined;
  }

  return creds.subscriptionType?.trim() ? titleCase(creds.subscriptionType.trim()) : undefined;
}
