/**
 * Per-platform strategy for the MCP server's channel-scoped tools.
 *
 * The MCP server used to branch on PLATFORM_TYPE at every dispatch point:
 * permalink resolution (read_post, react_to_post, update_own_post,
 * list_thread), channel-id shape validation, and per-platform error
 * wording. Those branches ARE the channel-scope security boundary — the
 * scope predicate (bot's channel ∪ public channels on the same instance)
 * is enforced inside each platform's resolver — so they live here as one
 * strategy object per platform: adding a platform means implementing this
 * interface once, not finding every conditional in mcp-server.ts.
 */

import type { McpPlatformApi } from '../platform/mcp-platform-api.js';
import type { ResolveOptions, ResolveError, ResolvedPermalink } from '../platform/permalink-shared.js';
import {
  parseMattermostPermalink,
  resolvePermalink,
  formatResolved,
} from '../platform/mattermost/permalink.js';
import {
  parseSlackPermalink,
  resolveSlackPermalink,
  formatResolvedSlack,
} from '../platform/slack/permalink.js';

export interface PermalinkResolveConfig {
  api: McpPlatformApi;
  /** Mattermost: instance base URL. Slack: unused (workspaces are
   *  identified at API level, not by URL). */
  platformUrl: string;
  /** The bot's channel id — the anchor of the scope predicate. */
  channelId: string;
}

export type StrategyResolveResult =
  | { ok: true; resolved: ResolvedPermalink }
  | { ok: false; reason: string };

export interface McpPlatformStrategy {
  /**
   * Parse `url` as this platform's permalink and resolve it within the
   * bot's scope. Every failure (unconfigured platform, foreign URL,
   * out-of-scope or missing post) comes back as a user-facing reason
   * string the tool can surface to Claude unchanged.
   */
  resolvePermalinkUrl(
    url: string,
    cfg: PermalinkResolveConfig,
    opts?: ResolveOptions,
  ): Promise<StrategyResolveResult>;
  /** Render a resolved permalink (post + optional thread) for Claude. */
  formatResolved(resolved: ResolvedPermalink): string;
  /** Shape of a valid channel id — a misuse guard (URL or name pasted
   *  instead of an id), not a security check. */
  channelIdPattern: RegExp;
  /** Wording when readChannelHistory returns null for a channel. */
  channelNotAccessibleReason: string;
  /** Set when the platform cannot support search_messages at all;
   *  surfaced verbatim so Claude stops retrying. */
  searchUnsupportedReason?: string;
}

/**
 * Map a Mattermost resolver error to a friendly user-facing reason.
 * Shared between read_post and the other permalink tools so the wording
 * can't drift.
 *
 * Note: `wrong-channel` from the resolver fires only when the post is
 * private AND not in the bot's channel — public posts on the same
 * instance are always in scope (see resolvePermalink's channelType check).
 * That's why the message is specifically about *private* channels.
 */
function mattermostResolveErrorReason(error: ResolveError): string {
  switch (error.kind) {
    case 'wrong-channel':
      return 'permalink is for a private channel the bot is not in';
    case 'not-found':
      return 'post not found, or the bot does not have access to it';
    case 'unsupported':
      return 'this platform does not support reading posts';
  }
}

/**
 * Map a Slack resolver error to a friendly user-facing reason. Slack's
 * `wrong-channel` is about cross-channel scope (Slack's API hard-limits
 * us to channels the bot is a member of), not about visibility.
 */
function slackResolveErrorReason(error: ResolveError): string {
  switch (error.kind) {
    case 'wrong-channel':
      return 'permalink is for a different channel — the bot can only act on links inside its own channel';
    case 'not-found':
      return 'message not found, or the bot does not have access to it';
    case 'unsupported':
      return 'this platform does not support reading posts';
  }
}

const mattermostStrategy: McpPlatformStrategy = {
  async resolvePermalinkUrl(url, cfg, opts) {
    if (!cfg.platformUrl) {
      return { ok: false, reason: 'platform URL not configured' };
    }
    if (!cfg.channelId) {
      return { ok: false, reason: 'platform channel not configured' };
    }
    const parsed = parseMattermostPermalink(url, cfg.platformUrl);
    if (!parsed) {
      return {
        ok: false,
        reason: `not a Mattermost permalink for ${cfg.platformUrl} (the bot can only follow links on its own instance)`,
      };
    }
    const result = await resolvePermalink(cfg.api, parsed.postId, cfg.channelId, opts);
    if (!result.ok) {
      return { ok: false, reason: mattermostResolveErrorReason(result.error) };
    }
    return { ok: true, resolved: result.resolved };
  },
  formatResolved,
  channelIdPattern: /^[a-z0-9]{26}$/,
  channelNotAccessibleReason: 'channel not accessible to the bot',
};

const slackStrategy: McpPlatformStrategy = {
  async resolvePermalinkUrl(url, cfg, opts) {
    if (!cfg.channelId) {
      return { ok: false, reason: 'platform channel not configured' };
    }
    const parsed = parseSlackPermalink(url);
    if (!parsed) {
      return {
        ok: false,
        reason: 'not a Slack permalink (expected https://{workspace}.slack.com/archives/{channelId}/p{ts})',
      };
    }
    const result = await resolveSlackPermalink(cfg.api, parsed, cfg.channelId, opts);
    if (!result.ok) {
      return { ok: false, reason: slackResolveErrorReason(result.error) };
    }
    return { ok: true, resolved: result.resolved };
  },
  formatResolved: formatResolvedSlack,
  channelIdPattern: /^[CGD][A-Z0-9]{8,12}$/,
  channelNotAccessibleReason: 'bot is not a member of that channel — invite it before reading history',
  // Slack search.messages requires a user token (xoxp), not the bot token.
  searchUnsupportedReason:
    'search not supported on Slack with bot tokens (Slack requires a user token for search.messages, which is not configured)',
};

const STRATEGIES: Record<string, McpPlatformStrategy> = {
  mattermost: mattermostStrategy,
  slack: slackStrategy,
};

/** The strategy for `platformType`, or null when the platform is unknown. */
export function mcpPlatformStrategy(platformType: string): McpPlatformStrategy | null {
  return STRATEGIES[platformType] ?? null;
}
