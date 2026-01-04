/**
 * LogPanel component - displays global log messages
 * Only shows info/warn/error level (filters out debug noise)
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

// Pad component name to fixed width for alignment
const COMPONENT_WIDTH = 9;
function padComponent(name: string): string {
  return name.padEnd(COMPONENT_WIDTH);
}

export function LogPanel({ logs, maxLines = 10 }: LogPanelProps) {
  // Filter out debug logs and show only the last N
  const displayLogs = logs
    .filter(log => log.level !== 'debug')
    .slice(-maxLines);

  if (displayLogs.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {displayLogs.map((log) => (
        <Box key={log.id}>
          <Text dimColor>[{padComponent(log.component)}]</Text>
          <Text color={getLevelColor(log.level)}> {log.message}</Text>
        </Box>
      ))}
    </Box>
  );
}
