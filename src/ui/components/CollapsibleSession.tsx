/**
 * CollapsibleSession component - expandable session panel
 */
import { Box, Text } from 'ink';
import type { SessionInfo, LogEntry } from '../types.js';
import { SessionLog } from './SessionLog.js';
import { Spinner } from './Spinner.js';

interface CollapsibleSessionProps {
  session: SessionInfo;
  logs: LogEntry[];
  expanded: boolean;
  sessionNumber: number;
}

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

export function CollapsibleSession({
  session,
  logs,
  expanded,
  sessionNumber,
}: CollapsibleSessionProps) {
  const { icon, color } = getStatusIndicator(session.status);
  const arrow = expanded ? '▼' : '▶';
  const shortId = session.id.slice(0, 8);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header line */}
      <Box gap={1}>
        <Text dimColor>{arrow}</Text>
        <Text bold>Session {shortId}</Text>
        <Text dimColor>(@{session.startedBy})</Text>
        <Text color={color}>{icon}</Text>
        <Text dimColor>{session.status}</Text>
        {session.worktreeBranch && (
          <>
            <Text dimColor>│</Text>
            <Text color="magenta">{session.worktreeBranch}</Text>
          </>
        )}
        <Text dimColor>{'─'.repeat(Math.max(0, 40 - shortId.length - session.startedBy.length))}</Text>
      </Box>

      {/* Expanded content */}
      {expanded && (
        <Box flexDirection="column">
          <SessionLog logs={logs} />
          {(session.status === 'active' || session.status === 'starting') && (
            <Box paddingLeft={2} marginTop={0}>
              <Spinner label="Thinking..." />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
