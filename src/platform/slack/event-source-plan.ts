/**
 * Plan which configured Slack entries share one Socket Mode connection.
 *
 * Slack round-robins Socket Mode envelopes across all of an app's open
 * connections. Two `platforms:` entries with the same app token that each open
 * a socket therefore lose each other's events, in both channels, silently.
 * With the shared event source (#502) one parent owns the socket and injects
 * events for other channels into secondaries.
 *
 * Rule: per app token, the first enabled entry is the parent, and every other
 * entry on that token (enabled or not) is its secondary. When no entry on the
 * token is enabled, the first one is the parent anyway: the plan is fixed for
 * the life of the process, and entries that are enabled later at runtime must
 * not each open a socket of their own.
 *
 * @returns secondary platform id → parent platform id
 */
export function planSlackEventSources(
  platforms: ReadonlyArray<{ id: string; type: string; appToken?: string }>,
  isEnabled: (id: string) => boolean,
): Map<string, string> {
  const parentByToken = new Map<string, string>();
  for (const enabledOnly of [true, false]) {
    for (const p of platforms) {
      if (p.type !== 'slack' || !p.appToken || parentByToken.has(p.appToken)) continue;
      if (!enabledOnly || isEnabled(p.id)) parentByToken.set(p.appToken, p.id);
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

/** The ids that receive their events through `parentId`'s connection. */
export function secondariesOf(plan: ReadonlyMap<string, string>, parentId: string): string[] {
  return [...plan].filter(([, parent]) => parent === parentId).map(([id]) => id);
}

/**
 * Entries on one app token that name the same channel. The shared connection
 * routes by channel id, so only one of them can receive that channel's events.
 *
 * @returns one `[id, earlierId, channelId]` per entry that repeats a channel
 */
export function findSharedChannelConflicts(
  platforms: ReadonlyArray<{ id: string; type: string; appToken?: string; channelId?: string }>,
): Array<[id: string, earlierId: string, channelId: string]> {
  const firstByKey = new Map<string, string>();
  const conflicts: Array<[string, string, string]> = [];
  for (const p of platforms) {
    if (p.type !== 'slack' || !p.appToken || !p.channelId) continue;
    const key = JSON.stringify([p.appToken, p.channelId]);
    const earlier = firstByKey.get(key);
    if (earlier === undefined) firstByKey.set(key, p.id);
    else conflicts.push([p.id, earlier, p.channelId]);
  }
  return conflicts;
}

/**
 * Build one client per configured platform. A secondary needs its parent's
 * client at construction, so parents are built first.
 */
export function buildPlatformClients<Config extends { id: string }, Client>(
  platforms: ReadonlyArray<Config>,
  plan: ReadonlyMap<string, string>,
  create: (config: Config, parent?: Client) => Client,
): Map<string, Client> {
  const built = new Map<string, Client>();
  for (const config of platforms) {
    if (!plan.has(config.id)) built.set(config.id, create(config));
  }
  for (const config of platforms) {
    const parentId = plan.get(config.id);
    if (parentId !== undefined) built.set(config.id, create(config, built.get(parentId)));
  }
  return built;
}

/**
 * Connect every entry, each parent only after its own secondaries. A
 * secondary's connect registers its channel with the parent, and that has to
 * be done before the parent's socket goes live: an event for a channel nobody
 * registered yet is dropped. Entries that share nothing connect in parallel,
 * as before.
 *
 * @returns one settled result per entry, in the order of `entries`
 */
export function connectSecondariesFirst<Entry extends readonly [string, unknown], Result>(
  entries: ReadonlyArray<Entry>,
  plan: ReadonlyMap<string, string>,
  connectOne: (entry: Entry) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  const pending = new Map<string, Promise<Result>>();
  for (const entry of entries) {
    if (plan.has(entry[0])) pending.set(entry[0], connectOne(entry));
  }
  for (const entry of entries) {
    if (plan.has(entry[0])) continue;
    const own = secondariesOf(plan, entry[0]).map((id) => pending.get(id)).filter((c) => c !== undefined);
    pending.set(entry[0], Promise.allSettled(own).then(() => connectOne(entry)));
  }
  return Promise.allSettled(entries.map(([id]) => pending.get(id) as Promise<Result>));
}
