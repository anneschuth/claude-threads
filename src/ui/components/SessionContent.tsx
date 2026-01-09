/**
 * SessionContent component - displays full session content in the tabs view
 *
 * Shows:
 * - Session header (title, user, time, branch)
 * - Separator
 * - Scrollable log area
 * - Typing/loading indicator
 */
import { Box, Text } from 'ink';
import type { SessionInfo, LogEntry } from '../types.js';
import { SessionLog } from './SessionLog.js';
import { Spinner } from './Spinner.js';
import { formatRelativeTimeShort } from '../../utils/format.js';
import { getPlatformIcon } from '../../platform/utils.js';

interface SessionContentProps {
  session: SessionInfo;
  logs: LogEntry[];
  /** Available height for the content area */
  height?: number;
}

/**
 * Get status indicator for display in header
 */
function getStatusIndicator(status: SessionInfo['status']): { icon: string; color: string; label: string } {
  switch (status) {
    case 'active':
      return { icon: '●', color: 'green', label: 'active' };
    case 'starting':
      return { icon: '◌', color: 'yellow', label: 'starting' };
    case 'idle':
      return { icon: '○', color: 'gray', label: 'idle' };
    case 'stopping':
      return { icon: '◌', color: 'yellow', label: 'stopping' };
    case 'paused':
      return { icon: '⏸', color: 'blue', label: 'paused' };
    default:
      return { icon: '○', color: 'gray', label: 'unknown' };
  }
}

/**
 * Empty state when no session is selected
 */
function EmptyState() {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Text dimColor>No session selected</Text>
      <Text dimColor italic>Press 1-9 to select a session</Text>
    </Box>
  );
}

/**
 * Session header with metadata
 */
function SessionHeader({ session }: { session: SessionInfo }) {
  const { icon, color } = getStatusIndicator(session.status);
  const platformIcon = getPlatformIcon(session.platformType || 'mattermost');
  const timeAgo = session.lastActivity ? formatRelativeTimeShort(session.lastActivity) : '';
  const displayTitle = session.title || 'Untitled session';

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* Title line */}
      <Box gap={1} overflow="hidden">
        <Text>{platformIcon}</Text>
        <Text color="cyan" bold wrap="truncate">{displayTitle}</Text>
        <Text color={color}>{icon}</Text>
      </Box>

      {/* Metadata line */}
      <Box gap={1} overflow="hidden">
        <Text color="yellow" wrap="truncate">@{session.startedBy}</Text>
        {timeAgo && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>{timeAgo}</Text>
          </>
        )}
        {session.worktreeBranch && (
          <>
            <Text dimColor>·</Text>
            <Text color="magenta" wrap="truncate">{session.worktreeBranch}</Text>
          </>
        )}
      </Box>

      {/* Description (if available) */}
      {session.description && (
        <Box overflow="hidden">
          <Text dimColor italic wrap="truncate">{session.description}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Full session content view for the tabbed interface
 */
export function SessionContent({ session, logs, height }: SessionContentProps) {
  if (!session) {
    return <EmptyState />;
  }

  // Calculate log area height (total - header lines - typing indicator)
  const headerLines = session.description ? 3 : 2;
  const footerLines = 1; // For typing indicator
  const separatorLines = 1;
  const logHeight = height ? height - headerLines - footerLines - separatorLines : undefined;

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {/* Session header */}
      <SessionHeader session={session} />

      {/* Separator */}
      <Box>
        <Text dimColor>{'─'.repeat(60)}</Text>
      </Box>

      {/* Log area - takes remaining space */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden" height={logHeight}>
        <SessionLog logs={logs} maxLines={logHeight} />
      </Box>

      {/* Typing/loading indicator at bottom */}
      <Box height={1}>
        {session.status === 'starting' ? (
          <Spinner label="Starting Claude..." type="dots" />
        ) : session.isTyping ? (
          <Spinner label="Typing..." type="simpleDots" />
        ) : null}
      </Box>
    </Box>
  );
}
