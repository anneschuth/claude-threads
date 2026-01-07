/**
 * StatusLine component - bot status bar at the bottom
 *
 * Shows the overall bot status, runtime toggles, and keyboard hints.
 * Visually separated from sessions with a line.
 */
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import type { ToggleState, PlatformStatus, UpdatePanelState } from '../types.js';

interface StatusLineProps {
  ready: boolean;
  shuttingDown?: boolean;
  sessionCount: number;
  toggles: ToggleState;
  platforms: Map<string, PlatformStatus>;
  updateState?: UpdatePanelState;
}

/**
 * Render a toggle key hint with current state
 */
function ToggleKey({ keyChar, label, enabled, color }: { keyChar: string; label: string; enabled: boolean; color?: string }) {
  const displayColor = color ?? (enabled ? 'green' : 'gray');
  return (
    <Box gap={0}>
      <Text dimColor>[</Text>
      <Text color={displayColor} bold>{keyChar}</Text>
      <Text dimColor>]</Text>
      <Text color={displayColor}>{label}</Text>
    </Box>
  );
}

/**
 * Get the color for the update toggle based on update state
 */
function getUpdateColor(state?: UpdatePanelState): string {
  if (!state) return 'gray';
  switch (state.status) {
    case 'available':
      return 'green';
    case 'scheduled':
    case 'installing':
    case 'pending_restart':
      return 'yellow';
    case 'failed':
      return 'red';
    case 'deferred':
    case 'idle':
    default:
      return 'gray';
  }
}

/**
 * Get the update indicator emoji based on state
 */
function getUpdateIndicator(state?: UpdatePanelState): string {
  if (!state) return '';
  switch (state.status) {
    case 'available':
      return ' 🆕';
    case 'installing':
      return ' 📦';
    case 'failed':
      return ' ❌';
    default:
      return '';
  }
}

/**
 * Render a platform toggle with status indicator
 * Shows: [⇧1]Name with color based on enabled/connected/reconnecting state
 */
function PlatformToggle({
  index,
  platform,
}: {
  index: number;
  platform: PlatformStatus;
}) {
  // Determine color: yellow if reconnecting, green if enabled+connected, gray if disabled
  let color: string;
  if (!platform.enabled) {
    color = 'gray';
  } else if (platform.reconnecting) {
    color = 'yellow';
  } else if (platform.connected) {
    color = 'green';
  } else {
    color = 'red'; // Enabled but not connected (error state)
  }

  // Shorten display name for status line
  const shortName = platform.displayName.length > 8
    ? platform.displayName.slice(0, 7) + '…'
    : platform.displayName;

  return (
    <Box gap={0}>
      <Text dimColor>[⇧</Text>
      <Text color={color} bold>{index + 1}</Text>
      <Text dimColor>]</Text>
      <Text color={color}>{shortName}</Text>
    </Box>
  );
}

export function StatusLine({
  ready,
  shuttingDown,
  sessionCount,
  toggles,
  platforms,
  updateState,
}: StatusLineProps) {
  const platformList = Array.from(platforms.values());
  const updateColor = getUpdateColor(updateState);
  const updateIndicator = getUpdateIndicator(updateState);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Separator line */}
      <Text dimColor>{'─'.repeat(80)}</Text>

      {/* Status row */}
      <Box gap={2}>
        {/* Bot status */}
        {shuttingDown ? (
          <Box gap={1}>
            <Spinner type="line" />
            <Text color="yellow">Shutting down...</Text>
          </Box>
        ) : ready ? (
          <Box gap={1}>
            <Text color="green">✓</Text>
            <Text dimColor>Ready</Text>
          </Box>
        ) : (
          <Box gap={1}>
            <Spinner type="dots" />
            <Text dimColor>Starting...</Text>
          </Box>
        )}

        {!shuttingDown && (
          <>
            <Text dimColor>│</Text>

            {/* Runtime toggles with key hints */}
            <ToggleKey keyChar="d" label="ebug" enabled={toggles.debugMode} />
            <ToggleKey keyChar="p" label="erms" enabled={!toggles.skipPermissions} />
            <ToggleKey keyChar="c" label="hrome" enabled={toggles.chromeEnabled} />
            <ToggleKey keyChar="k" label="eep-alive" enabled={toggles.keepAliveEnabled} />
            <Box gap={0}>
              <ToggleKey keyChar="u" label="pdate" enabled={updateState?.status === 'available'} color={updateColor} />
              {updateIndicator && <Text>{updateIndicator}</Text>}
            </Box>

            {/* Platform toggles */}
            {platformList.length > 0 && (
              <>
                <Text dimColor>│</Text>
                {platformList.slice(0, 9).map((platform, index) => (
                  <PlatformToggle key={platform.id} index={index} platform={platform} />
                ))}
              </>
            )}

            {/* Session toggle hint */}
            {sessionCount > 0 && (
              <>
                <Text dimColor>│</Text>
                <Text dimColor>1-{Math.min(sessionCount, 9)} sessions</Text>
              </>
            )}

            <Text dimColor>│</Text>
            <Text dimColor>[q]uit</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
