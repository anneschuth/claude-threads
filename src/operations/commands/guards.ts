/**
 * Shared gates for user commands: the owner/participant authorization check
 * and the audit-trail hook. Split from handler.ts so the per-domain command
 * modules (memory, automation) share one policy.
 */

import type { Session } from '../../session/types.js';
import { isDcmThreadId, resolveApprovals } from '../../platform/utils.js';
import { auditLog } from '../../persistence/audit-log.js';
import { post } from '../post-helpers/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';

const log = createLogger('commands');
const sessionLog = createSessionLog(log);

/** Audit a security-relevant command execution (no-op unless enabled). */
export function auditCommand(session: Session, command: string, detail: string | undefined, username: string): void {
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: username,
    kind: 'command',
    tool: command,
    detail,
  });
}

export async function requireSessionOwner(
  session: Session,
  username: string,
  action: string
): Promise<boolean> {
  const formatter = session.platform.getFormatter();
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await post(session, 'warning', `Only ${formatter.formatUserMention(session.startedBy)} or allowed users can ${action}`);
    sessionLog(session).warn(`Unauthorized: @${username} tried to ${action}`);
    return false;
  }
  // SECURITY: under effective approvals mode `owner`, owner-gated commands
  // additionally require being a session participant. Without this, any
  // platform-allowlisted non-participant could `!invite` themselves past the
  // owner-scoped reaction gate, reducing `owner` to an audit trail.
  const ownerScoped =
    resolveApprovals(session.platform.approvals, isDcmThreadId(session.threadId)) === 'owner';
  if (ownerScoped && !session.sessionAllowedUsers.has(username)) {
    await post(session, 'warning', `Only session participants can ${action} in this session`);
    sessionLog(session).warn(`Unauthorized: non-participant @${username} tried to ${action} (approvals: owner)`);
    return false;
  }
  return true;
}
