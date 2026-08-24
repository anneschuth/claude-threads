/**
 * DM auto-discovery runtime (Mattermost only).
 *
 * Owns the lifecycle of derived DM platform instances: live discovery from a
 * parent entry's 'direct_message' events, boot reconstruction from persisted
 * sessions, ABA-safe teardown (grace timers, orphan reaper), and the routed-
 * post dedupe for the parent→instance handover window.
 *
 * Extracted from index.ts so the exact production code path is testable —
 * dependencies (platform registry, session manager, client factory, message
 * delivery) are injected, and the timers are overridable for tests.
 */

import { dcmThreadId } from './utils.js';
import type { MattermostPlatformConfig, PlatformInstanceConfig } from '../config/types.js';
import { configureAuditLog } from '../persistence/audit-log.js';
import type { PlatformClient, PlatformPost, PlatformUser } from './index.js';
import type { SessionManager } from '../session/index.js';
import type { PersistedSession } from '../persistence/session-store.js';
import { dmPlatformId, DM_PLATFORM_SEP, deriveDmPlatformConfig } from './dm-discovery.js';
import { _inFlightSessionStarts } from '../session/lifecycle.js';

export interface DmDiscoveryDeps {
  /** The live platform registry (shared with the rest of the bot). */
  platforms: Map<string, PlatformClient>;
  session: SessionManager;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Create, register (UI + session manager + event wiring) and return the
   * client for a derived DM config. The runtime owns all DM bookkeeping; this
   * callback owns everything host-specific.
   */
  registerPlatform: (config: MattermostPlatformConfig) => PlatformClient;
  /** Deliver a message through the production message handler. */
  deliverMessage: (
    client: PlatformClient,
    post: PlatformPost,
    user: PlatformUser | null,
    platformId: string,
  ) => Promise<void>;
  /** Resumable persisted sessions (soft-deleted records excluded). */
  loadPersistedSessions: () => Map<string, PersistedSession>;
  /**
   * Whether a (derived) platform id is enabled. Consulted by live discovery
   * as well as boot reconstruction — a user-disabled DM instance must not be
   * silently re-enabled by the next incoming DM. Default: everything enabled.
   */
  isEnabled?: (platformId: string) => boolean;
  /**
   * Remove the host UI's status row for a torn-down instance. Without this,
   * every DM channel ever contacted leaves a permanent row behind. Disabled
   * instances keep their row (it is the re-enable handle).
   */
  removeUiRow?: (platformId: string) => void;
  /** Grace before tearing down an instance after its session leaves the registry. */
  graceMs?: number;
  /** How long a discovered instance may exist without ever producing a session. */
  orphanTtlMs?: number;
}

export interface DmDiscoveryRuntime {
  /** Listen for cold DMs on a parent entry with `directMessages: true`. */
  wireParent(parentConfig: MattermostPlatformConfig, parentClient: PlatformClient): void;
  /**
   * Rebuild derived instances for persisted DM sessions (call before
   * connect). Returns the disabled instances that were skipped, so the host
   * can still surface them (e.g. as a UI row) — otherwise a disabled DM
   * instance would be un-toggleable after a restart.
   */
  reconstructPersisted(platformConfigs: PlatformInstanceConfig[], isEnabled: (id: string) => boolean): Array<{ platformId: string; channelId: string }>;
  /** Settle a reconstructed instance's boot connect result (no-op for others). */
  settleBootResult(id: string, success: boolean, client: PlatformClient | undefined): void;
  /** Hook for the host's session:remove listener. */
  onSessionRemove(sessionId: string): void;
  /** Handover dedupe: true if the parent already routed this post (refreshes LRU). */
  isRoutedPost(postId: string): boolean;
}

export function createDmDiscoveryRuntime(deps: DmDiscoveryDeps): DmDiscoveryRuntime {
  const { platforms, session, log } = deps;
  const graceMs = deps.graceMs ?? 30_000;
  const orphanTtlMs = deps.orphanTtlMs ?? 10 * 60_000;

  /** Derived DM instances: DM channel id → derived platform id (first parent wins). */
  const instanceByChannel = new Map<string, string>();
  /** Derived instances whose own websocket has not confirmed connecting yet. */
  const connecting = new Set<string>();
  /** Post ids already routed via the parent during the connect window (LRU dedupe). */
  const routedPosts = new Set<string>();
  /** Pending grace timers per derived platform id (cancelled on re-discovery). */
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Boot-reconstructed instances awaiting their connect result: dmId → channelId. */
  const reconstructed = new Map<string, string>();

  const rememberRoutedPost = (postId: string): void => {
    // Refresh recency on re-insert so this behaves as an LRU, not a FIFO.
    routedPosts.delete(postId);
    routedPosts.add(postId);
    if (routedPosts.size > 200) {
      const oldest = routedPosts.values().next().value;
      if (oldest) routedPosts.delete(oldest);
    }
  };

  const isRoutedPost = (postId: string): boolean => {
    if (!routedPosts.has(postId)) return false;
    rememberRoutedPost(postId);
    return true;
  };

  const cancelGraceTimer = (dmId: string): void => {
    const timer = graceTimers.get(dmId);
    if (timer) {
      clearTimeout(timer);
      graceTimers.delete(dmId);
    }
  };

  /**
   * Tear down one derived DM instance. ABA-guarded two ways: the channel must
   * still map to this dmId, and — because re-discovery deterministically
   * recreates the SAME dmId — callers pass the client instance they intend to
   * remove, so a stale timer can never tear down a newer client.
   */
  const teardown = (channelId: string, dmId: string, reason: string, expectedClient?: PlatformClient): void => {
    if (instanceByChannel.get(channelId) !== dmId) return;
    const client = platforms.get(dmId);
    if (expectedClient && client !== expectedClient) return;
    cancelGraceTimer(dmId);
    instanceByChannel.delete(channelId);
    connecting.delete(dmId);
    platforms.delete(dmId);
    session.removePlatform(dmId);
    if (client) void Promise.resolve(client.disconnect()).catch(() => {});
    configureAuditLog(dmId, false);
    // Drop the UI row — except for disabled instances, whose row is the only
    // handle to re-enable them.
    if (deps.isEnabled?.(dmId) !== false) deps.removeUiRow?.(dmId);
    log('info', `🧹 DM instance ${dmId} torn down (${reason})`);
  };

  const register = (parentCfg: MattermostPlatformConfig, channelId: string, partnerUsernames: string[]): PlatformClient => {
    const dmConfig = deriveDmPlatformConfig(parentCfg, channelId, partnerUsernames);
    // Re-discovery under the same deterministic id: a pending grace timer for
    // the previous incarnation must not fire against the new instance.
    cancelGraceTimer(dmConfig.id);
    const dmClient = deps.registerPlatform(dmConfig);
    instanceByChannel.set(channelId, dmConfig.id);
    return dmClient;
  };

  const wireParent = (parentConfig: MattermostPlatformConfig, parentClient: PlatformClient): void => {
    parentClient.on('direct_message', async (post: PlatformPost, user: PlatformUser | null) => {
      const username = user?.username;
      // Same semantics as everywhere else: an empty allowlist means "everyone
      // in the channel" — with directMessages that is every user who can DM
      // the bot, so leave it empty only on servers you trust (documented).
      if (!username || !parentClient.isUserAllowed(username)) return;
      if (isRoutedPost(post.id)) return;

      // First parent wins across multiple entries sharing one bot account:
      // if any instance owns this DM channel, only route during its connect
      // window (its own socket misses those messages), otherwise stay out.
      const existingDmId = instanceByChannel.get(post.channelId);
      if (existingDmId) {
        if (connecting.has(existingDmId)) {
          const existingClient = platforms.get(existingDmId);
          if (existingClient) {
            rememberRoutedPost(post.id);
            await deps.deliverMessage(existingClient, post, user, existingDmId);
          }
        }
        return;
      }

      const dmId = dmPlatformId(parentConfig.id, post.channelId);
      // A user-disabled derived instance stays down — an incoming DM must not
      // silently re-enable it (mirrors the boot-reconstruction check).
      if (deps.isEnabled && !deps.isEnabled(dmId)) {
        log('info', `Ignoring DM for disabled instance ${dmId}`);
        return;
      }
      log('info', `📩 New DM conversation with @${username} — spawning ${dmId}`);
      const dmClient = register(parentConfig, post.channelId, [username]);
      connecting.add(dmId);
      dmClient.connect().then(() => {
        // Stale-completion guard (ABA): only act if this exact client still
        // owns the id.
        if (platforms.get(dmId) !== dmClient) return;
        connecting.delete(dmId);
      }).catch((err: unknown) => {
        if (platforms.get(dmId) !== dmClient) return;
        // A dead instance must not permanently block the channel. A session
        // created from the first message would be stranded on the
        // disconnected client — cancel it (awaited; the notification still
        // reaches the DM via REST) so the next DM starts fresh.
        log('error', `Failed to connect DM instance ${dmId}, discarding: ${err}`);
        void (async () => {
          const threadId = dcmThreadId(dmId);
          // The first message's session start may still be in flight (the
          // session registers only late in startSession) — wait for it, or
          // the registry check below would miss a session that materializes
          // a moment later and strand it. Loop: a failed start can be
          // replaced by a waiter's retry attempt under the same key, so keep
          // waiting until the map is empty for this key (same convergence
          // argument as the startSession wrapper). Bounded: if an attempt
          // promise ever fails to settle, this dead instance must not own
          // the channel forever and block rediscovery — the end-state sweep
          // below catches a session that registers after we move on.
          const inFlightDeadline = Date.now() + 30_000;
          for (;;) {
            const inFlight = _inFlightSessionStarts.get(`${dmId}:${threadId}`);
            if (!inFlight) break;
            if (Date.now() > inFlightDeadline) {
              log('warn', `In-flight session start for ${dmId} did not settle within 30s — proceeding with teardown`);
              break;
            }
            await Promise.race([
              inFlight.catch(() => {}),
              new Promise((res) => setTimeout(res, 1_000)),
            ]);
          }
          if (session.registry.findByThreadId(threadId)) {
            // Awaited so the session is gone before the platform vanishes.
            // One retry: the cancel path posts a notification first, and a
            // transient post failure must not leave an active session
            // registered on a removed platform.
            try {
              await session.cancelSession(threadId, dmClient.getBotName());
            } catch {
              try {
                await session.cancelSession(threadId, dmClient.getBotName());
              } catch (cancelErr) {
                log('warn', `Failed to cancel stranded DM session ${threadId} (will be reaped by idle cleanup): ${cancelErr}`);
              }
            }
          }
          teardown(post.channelId, dmId, 'connect failed', dmClient);
          // Sweep: whatever ordering the start/retry races take, the end-state
          // invariant is enforced here — a session whose platform is gone
          // (e.g. a retry generation that slipped through the transient
          // empty-map window and registered late) is cancelled shortly after.
          // Losing that one message is within the declared failure model.
          setTimeout(() => {
            if (platforms.has(dmId)) return; // rediscovered — session is fine
            if (!session.registry.findByThreadId(threadId)) return;
            log('warn', `Sweeping session stranded on removed DM platform ${dmId}`);
            void session.cancelSession(threadId, dmClient.getBotName()).catch(() => {});
          }, 2000);
        })();
      });
      // Orphan reaper: an instance whose first message never produced a
      // session (empty prompt, immediate command, capacity rejection) emits
      // no session:remove — reap it after a TTL unless a session exists, the
      // conversation is resumably persisted, or a grace teardown is pending.
      setTimeout(() => {
        if (platforms.get(dmId) !== dmClient) return;
        const threadId = dcmThreadId(dmId);
        if (session.registry.findByThreadId(threadId)) return;
        for (const [, p] of deps.loadPersistedSessions()) {
          if (p.threadId === threadId) return;
        }
        if (graceTimers.has(dmId)) return;
        teardown(post.channelId, dmId, 'no session within TTL', dmClient);
      }, orphanTtlMs);
      rememberRoutedPost(post.id);
      await deps.deliverMessage(dmClient, post, user, dmId);
    });
  };

  const reconstructPersisted = (platformConfigs: PlatformInstanceConfig[], isEnabled: (id: string) => boolean): Array<{ platformId: string; channelId: string }> => {
    const skippedDisabled: Array<{ platformId: string; channelId: string }> = [];
    for (const [, persisted] of deps.loadPersistedSessions()) {
      const pid = persisted.platformId || '';
      if (!pid.includes(DM_PLATFORM_SEP) || platforms.has(pid)) continue;
      // Prefix-match against the actual configured parents (longest id wins)
      // instead of blind string parsing — injective even if a platform id
      // itself contains the separator. A renamed parent strands its DM
      // sessions (as it does any persisted session); we only warn.
      const parentCfg = platformConfigs
        .filter(
          (p): p is MattermostPlatformConfig =>
            p.type === 'mattermost' &&
            !!(p as MattermostPlatformConfig).directMessages &&
            pid.startsWith(`${p.id}${DM_PLATFORM_SEP}`)
        )
        .sort((a, b) => b.id.length - a.id.length)[0];
      if (!parentCfg) {
        log('warn', `Skipping persisted DM session for ${pid} (parent missing, renamed, or directMessages off)`);
        continue;
      }
      const channelId = pid.slice(parentCfg.id.length + DM_PLATFORM_SEP.length);
      // First instance wins per DM channel, mirroring live discovery.
      if (instanceByChannel.has(channelId)) {
        log('warn', `Skipping persisted DM session for ${pid} (channel already owned by ${instanceByChannel.get(channelId)})`);
        continue;
      }
      // A derived instance the user disabled stays down — but report it so
      // the host can keep it visible/toggleable.
      if (!isEnabled(pid)) {
        log('info', `Skipping disabled DM instance ${pid}`);
        skippedDisabled.push({ platformId: pid, channelId });
        continue;
      }
      // Asymmetry with live discovery is intentional: live discovery scopes
      // the derived allowlist to the DM partner alone (the only counterparty
      // a fresh 1:1 DM can have), while boot reconstruction restores the
      // persisted participant set — an `!invite`d collaborator must survive a
      // bot restart. Do not "fix" either side to match the other.
      const partners = (persisted.sessionAllowedUsers && persisted.sessionAllowedUsers.length > 0)
        ? persisted.sessionAllowedUsers
        : [persisted.startedBy].filter((u): u is string => !!u);
      log('info', `♻️ Reconstructing DM instance ${pid}`);
      register(parentCfg, channelId, partners);
      // Until its own socket is confirmed up, the parent must keep forwarding
      // this channel's messages — otherwise a DM arriving during startup is
      // silently dropped.
      connecting.add(pid);
      reconstructed.set(pid, channelId);
    }
    return skippedDisabled;
  };

  const settleBootResult = (id: string, success: boolean, client: PlatformClient | undefined): void => {
    const channelId = reconstructed.get(id);
    if (!channelId) return;
    reconstructed.delete(id);
    // Generation guard: only act on the client this result belongs to.
    if (!client || platforms.get(id) !== client) return;
    if (success) {
      connecting.delete(id);
    } else {
      teardown(channelId, id, 'boot connect failed', client);
    }
  };

  const onSessionRemove = (sessionId: string): void => {
    for (const [channelId, dmId] of instanceByChannel) {
      if (!sessionId.startsWith(`${dmId}:`)) continue;
      // Deferred behind a grace period: session:remove is emitted
      // synchronously during registry cleanup, and a message may still be
      // mid-flight on this instance. Re-check before acting.
      const expectedClient = platforms.get(dmId);
      cancelGraceTimer(dmId); // stacked session:remove events collapse to one timer
      const timer = setTimeout(() => {
        graceTimers.delete(dmId);
        if (session.registry.findByThreadId(dcmThreadId(dmId))) return; // new session took over
        teardown(channelId, dmId, 'session ended', expectedClient);
      }, graceMs);
      graceTimers.set(dmId, timer);
      return;
    }
  };

  return { wireParent, reconstructPersisted, settleBootResult, onSessionRemove, isRoutedPost };
}
