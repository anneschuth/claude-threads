/**
 * Platforms component - shows connected platforms with their status
 */
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import type { PlatformStatus } from '../types.js';
import { getPlatformIcon } from '../../platform/utils.js';

interface PlatformsProps {
  platforms: Map<string, PlatformStatus>;
}

export function Platforms({ platforms }: PlatformsProps) {
  if (platforms.size === 0) {
    return (
      <Box>
        <Spinner label="Connecting to platforms..." type="dots" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {Array.from(platforms.values()).map((platform, index) => (
        <Box key={platform.id} gap={1}>
          {/* Platform number */}
          <Text dimColor>{index + 1}.</Text>
          {/* Platform type icon */}
          <Text>{getPlatformIcon(platform.platformType || 'mattermost')}</Text>

          {/* Connection status indicator with optional spinner */}
          {!platform.enabled ? (
            <Text dimColor>○</Text>
          ) : platform.reconnecting ? (
            <Spinner type="dots" />
          ) : platform.connected ? (
            <Text color="green">●</Text>
          ) : (
            <Text color="red">○</Text>
          )}

          {/* Bot name */}
          <Text color={platform.enabled ? "cyan" : undefined} dimColor={!platform.enabled}>@{platform.botName}</Text>

          {/* Platform display name with optional reconnect count */}
          <Text dimColor>on</Text>
          <Text dimColor={!platform.enabled}>{platform.displayName}</Text>
          {platform.reconnecting && (
            <Text dimColor>(retry {platform.reconnectAttempts})</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
