/**
 * DM auto-discovery (Mattermost only).
 *
 * With `directMessages: true` on a Mattermost platform entry, a direct
 * message from an allowed user "out of the cold" spawns a derived platform
 * instance for that DM channel: a clone of the parent entry pointed at the
 * DM channel id, running in direct channel mode and scoped to the DM partner.
 * Everything downstream (sessions, persistence, permission prompts,
 * reactions) then works unchanged.
 *
 * Slack is deliberately excluded: Socket Mode distributes event envelopes
 * across an app's active connections, so a second connection on the same
 * credentials can consume events meant for the first. Mattermost WebSocket
 * connections each receive all events and filter locally, so one extra
 * connection per DM conversation is safe.
 */

import type { MattermostPlatformConfig } from '../config/types.js';

/** Separator between the parent platform id and the DM channel id. */
export const DM_PLATFORM_SEP = '--dm-';

/** Platform id for a derived DM instance. */
export function dmPlatformId(parentId: string, channelId: string): string {
  return `${parentId}${DM_PLATFORM_SEP}${channelId}`;
}

// NOTE: deliberately no parseDmPlatformId here — a parent platform id may
// itself contain the separator, so splitting at the first occurrence is
// ambiguous. Reconstruction resolves ids against the configured parents
// (longest-prefix match) instead.

/**
 * Derive the platform config for a DM instance from its parent entry.
 *
 * The clone runs in direct channel mode (a DM *is* a direct conversation),
 * hides the sticky (noise in a 1:1 chat), and scopes `allowedUsers` to the
 * DM partner — with the DCM approvals default (`owner`) that also scopes
 * tool-permission prompts to the participants.
 */
export function deriveDmPlatformConfig(
  parent: MattermostPlatformConfig,
  channelId: string,
  partnerUsernames: string[],
): MattermostPlatformConfig {
  return {
    ...parent,
    id: dmPlatformId(parent.id, channelId),
    displayName: `${parent.displayName || parent.id} DM (${partnerUsernames.join(', ')})`,
    channelId,
    directChannelMode: true,
    stickyMessage: 'hidden',
    allowedUsers: partnerUsernames,
    // The derived instance must not re-discover DMs itself.
    directMessages: false,
  };
}
