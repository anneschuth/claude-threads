/**
 * Footer component - bot status bar at the bottom
 *
 * Shows the overall bot status, runtime toggles, and keyboard hints.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import type { ToggleState, PlatformStatus, UpdatePanelState } from '../types.js';

interface FooterProps {
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
function ToggleKey({ keyChar, label, enabled, color }: {
  keyChar: string;
  label: string;
  enabled: boolean;
  color?: string;
}) {
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
 * Render a platform toggle with status indicator
 */
function PlatformToggle({ index, platform }: { index: number; platform: PlatformStatus }) {
  let color: string;
  if (!platform.enabled) {
    color = 'gray';
  } else if (platform.reconnecting) {
    color = 'yellow';
  } else if (platform.connected) {
    color = 'green';
  } else {
    color = 'red';
  }

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

export function Footer({
  ready,
  shuttingDown,
  sessionCount,
  toggles,
  platforms,
  updateState,
}: FooterProps) {
  const platformList = Array.from(platforms.values());

  return (
    <Box flexDirection="column">
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

            {/* Core toggles */}
            <ToggleKey keyChar="d" label="ebug" enabled={toggles.debugMode} />
            <ToggleKey keyChar="p" label="erms" enabled={!toggles.skipPermissions} />
            <ToggleKey keyChar="c" label="hrome" enabled={toggles.chromeEnabled} />
            <ToggleKey keyChar="k" label="eep" enabled={toggles.keepAliveEnabled} />
            <ToggleKey keyChar="l" label="ogs" enabled={toggles.logsFocused} color={toggles.logsFocused ? 'cyan' : 'gray'} />
            <ToggleKey
              keyChar="u"
              label="pdate"
              enabled={updateState?.status === 'available'}
              color={updateState?.status === 'available' ? 'green' : 'gray'}
            />

            {/* Platform toggles */}
            {platformList.length > 0 && (
              <>
                <Text dimColor>│</Text>
                {platformList.slice(0, 9).map((platform, index) => (
                  <PlatformToggle key={platform.id} index={index} platform={platform} />
                ))}
              </>
            )}

            {/* Session count */}
            {sessionCount > 0 && (
              <>
                <Text dimColor>│</Text>
                <Text dimColor>1-{Math.min(sessionCount, 9)} threads</Text>
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
