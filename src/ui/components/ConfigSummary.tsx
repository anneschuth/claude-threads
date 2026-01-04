/**
 * Configuration summary component - compact display of startup info
 */
import { Box, Text } from 'ink';
import type { AppConfig } from '../types.js';

interface ConfigSummaryProps {
  config: AppConfig;
}

export function ConfigSummary({ config }: ConfigSummaryProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1}>
        <Text>  📂</Text>
        <Text color="cyan">{config.workingDir}</Text>
      </Box>
      <Box gap={2}>
        <Box gap={1}>
          <Text>  💬</Text>
          <Text color="cyan">@{config.botName}</Text>
        </Box>
        <Text dimColor>│</Text>
        <Box gap={1}>
          <Text>🤖</Text>
          <Text dimColor>Claude {config.claudeVersion}</Text>
          {config.claudeCompatible ? (
            <Text color="green">✓</Text>
          ) : (
            <Text color="yellow">⚠</Text>
          )}
        </Box>
        {config.keepAliveEnabled && (
          <>
            <Text dimColor>│</Text>
            <Box gap={1}>
              <Text>☕</Text>
              <Text dimColor>Keep-alive</Text>
            </Box>
          </>
        )}
      </Box>
      <Box gap={2} marginTop={0}>
        {config.skipPermissions ? (
          <Text dimColor>  ⚠️ Permissions disabled</Text>
        ) : (
          <Text dimColor>  🔐 Interactive permissions</Text>
        )}
        {config.chromeEnabled && (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>🌐 Chrome</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
