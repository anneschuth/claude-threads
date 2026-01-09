/**
 * SessionLog component - displays log entries for a session
 */
import { Box, Text } from 'ink';
import type { LogEntry } from '../types.js';

interface SessionLogProps {
  logs: LogEntry[];
  maxLines?: number;
}

function getColorForLevel(level: LogEntry['level']): string | undefined {
  switch (level) {
    case 'error': return 'red';
    case 'warn': return 'yellow';
    case 'debug': return 'gray';
    default: return undefined;
  }
}

// Pad component name to fixed width for alignment
const COMPONENT_WIDTH = 10;
function padComponent(name: string): string {
  return name.padEnd(COMPONENT_WIDTH);
}

export function SessionLog({ logs, maxLines = 20 }: SessionLogProps) {
  // Show last N log entries
  const displayLogs = logs.slice(-maxLines);

  // Return nothing if no logs (session description handles empty state)
  if (displayLogs.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      {displayLogs.map((log) => (
        <Box key={log.id} flexShrink={0}>
          <Text color={getColorForLevel(log.level)} dimColor wrap="truncate">
            [{padComponent(log.component)}]
          </Text>
          <Text color={getColorForLevel(log.level)} wrap="truncate">
            {' '}{log.message}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
