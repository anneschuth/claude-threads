/**
 * Configuration summary component - compact display of startup info
 *
 * Note: This component shows static config from startup (Claude version, working dir).
 * Runtime toggles are shown in the bottom StatusLine component.
 */
import { Box, Text } from 'ink';
import type { AppConfig } from '../types.js';

interface ConfigSummaryProps {
  config: AppConfig;
}

export function ConfigSummary({ config }: ConfigSummaryProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Line 1: Working directory */}
      <Box gap={1}>
        <Text>📂</Text>
        <Text color="cyan">{config.workingDir}</Text>
      </Box>

      {/* Line 2: Claude version (static info only - runtime toggles are in StatusLine) */}
      <Box gap={2}>
        <Box gap={1}>
          <Text>🤖</Text>
          <Text dimColor>Claude {config.claudeVersion}</Text>
          {config.claudeCompatible ? (
            <Text color="green">✓</Text>
          ) : (
            <Text color="yellow">⚠</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
