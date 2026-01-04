/**
 * LogPanel component - displays global log messages
 */
import { Box, Text } from 'ink';
import type { LogEntry } from '../types.js';

interface LogPanelProps {
  logs: LogEntry[];
  maxLines?: number;
}

function getLevelColor(level: LogEntry['level']): string {
  switch (level) {
    case 'error':
      return 'red';
    case 'warn':
      return 'yellow';
    case 'debug':
      return 'gray';
    default:
      return 'white';
  }
}

export function LogPanel({ logs, maxLines = 10 }: LogPanelProps) {
  // Show only the last N logs
  const displayLogs = logs.slice(-maxLines);

  if (displayLogs.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {displayLogs.map((log) => (
        <Box key={log.id} gap={1}>
          <Text dimColor>[{log.component}]</Text>
          <Text color={getLevelColor(log.level)}>{log.message}</Text>
        </Box>
      ))}
    </Box>
  );
}
