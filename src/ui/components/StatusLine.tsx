/**
 * StatusLine component - ready message and keyboard hints
 */
import { Box, Text } from 'ink';

interface StatusLineProps {
  ready: boolean;
  botName: string;
  sessionCount: number;
  reconnecting?: boolean;
  reconnectAttempts?: number;
}

export function StatusLine({
  ready,
  botName,
  sessionCount,
  reconnecting,
  reconnectAttempts,
}: StatusLineProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {reconnecting && (
        <Box gap={1}>
          <Text color="yellow">  ⟳</Text>
          <Text dimColor>Reconnecting... (attempt {reconnectAttempts})</Text>
        </Box>
      )}

      {ready && !reconnecting && (
        <Box gap={1}>
          <Text color="green">  ✓</Text>
          <Text bold>Ready!</Text>
          <Text dimColor>Waiting for @{botName} mentions...</Text>
        </Box>
      )}

      {sessionCount > 0 && (
        <Box marginTop={0}>
          <Text dimColor>  Press 1-{Math.min(sessionCount, 9)} to toggle sessions</Text>
        </Box>
      )}
    </Box>
  );
}
