/**
 * TabBar component - displays session tabs with status indicators
 */
import { Box, Text } from 'ink';
import type { SessionInfo } from '../types.js';
import { getPlatformIcon } from '../../platform/utils.js';

interface TabBarProps {
  sessions: SessionInfo[];
  selectedId: string | null;
  onSelect?: (id: string) => void;
}

/**
 * Get status indicator for a session
 */
function getStatusIndicator(status: SessionInfo['status']): { icon: string; color: string } {
  switch (status) {
    case 'active':
    case 'starting':
      return { icon: '●', color: 'green' };
    case 'idle':
      return { icon: '○', color: 'gray' };
    case 'stopping':
      return { icon: '◌', color: 'yellow' };
    case 'paused':
      return { icon: '⏸', color: 'blue' };
    default:
      return { icon: '○', color: 'gray' };
  }
}

/**
 * Truncate title to fit in tab
 */
function truncateTitle(title: string, maxLength: number = 12): string {
  if (title.length <= maxLength) return title;
  return title.substring(0, maxLength - 1) + '…';
}

/**
 * Single tab component
 */
function Tab({
  session,
  index,
  isSelected,
}: {
  session: SessionInfo;
  index: number;
  isSelected: boolean;
}) {
  const { icon: statusIcon, color: statusColor } = getStatusIndicator(session.status);
  const platformIcon = getPlatformIcon(session.platformType || 'mattermost');
  const title = truncateTitle(session.title || `Session ${index + 1}`);

  return (
    <Box>
      <Text
        color={isSelected ? 'cyan' : undefined}
        bold={isSelected}
        dimColor={!isSelected}
      >
        [
      </Text>
      <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
        {index + 1}
      </Text>
      <Text dimColor> </Text>
      <Text>{platformIcon}</Text>
      <Text color={statusColor}>{statusIcon}</Text>
      <Text dimColor> </Text>
      <Text
        color={isSelected ? 'cyan' : undefined}
        bold={isSelected}
        dimColor={!isSelected}
      >
        {title}
      </Text>
      <Text
        color={isSelected ? 'cyan' : undefined}
        bold={isSelected}
        dimColor={!isSelected}
      >
        ]
      </Text>
    </Box>
  );
}

/**
 * Tab bar showing all sessions with status indicators
 *
 * Renders: [1 📢● Fix auth] [2 💬○ Feature] [3 💬○ Review]
 */
export function TabBar({ sessions, selectedId }: TabBarProps) {
  if (sessions.length === 0) {
    return (
      <Box>
        <Text dimColor italic>No active sessions - @mention the bot to start</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" gap={1} overflow="hidden">
      {sessions.slice(0, 9).map((session, index) => (
        <Tab
          key={session.id}
          session={session}
          index={index}
          isSelected={session.id === selectedId}
        />
      ))}
      {sessions.length > 9 && (
        <Text dimColor>+{sessions.length - 9} more</Text>
      )}
    </Box>
  );
}
