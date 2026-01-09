/**
 * UpdateModal component - displays auto-update status in a modal overlay
 *
 * Shows different content based on the update status:
 * - idle: "Up to date"
 * - available: Shows new version available
 * - scheduled: Shows scheduled restart time
 * - installing: Shows installation in progress
 * - pending_restart: Shows restart imminent
 * - failed: Shows error message
 * - deferred: Shows deferred until time
 */
import { Box, Text } from 'ink';
import { OverlayModal } from './OverlayModal.js';
import { Spinner } from './Spinner.js';
import type { UpdatePanelState } from '../types.js';

interface UpdateModalProps {
  state: UpdatePanelState;
}

/**
 * Format a date for display
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Get status display info based on update state
 */
function getStatusDisplay(state: UpdatePanelState): {
  icon: string;
  label: string;
  color: string;
} {
  switch (state.status) {
    case 'idle':
      return { icon: '✓', label: 'Up to date', color: 'green' };
    case 'available':
      return { icon: '🆕', label: 'Update available', color: 'green' };
    case 'scheduled':
      return { icon: '⏰', label: 'Restart scheduled', color: 'yellow' };
    case 'installing':
      return { icon: '📦', label: 'Installing...', color: 'cyan' };
    case 'pending_restart':
      return { icon: '🔄', label: 'Restarting...', color: 'yellow' };
    case 'failed':
      return { icon: '❌', label: 'Update failed', color: 'red' };
    case 'deferred':
      return { icon: '⏸️', label: 'Update deferred', color: 'gray' };
    default:
      return { icon: '?', label: 'Unknown', color: 'gray' };
  }
}

/**
 * Get the hint text based on update state
 */
function getHint(state: UpdatePanelState): string {
  const canUpdate = state.status === 'available' || state.status === 'deferred';
  if (canUpdate) {
    return 'Press [Shift+U] to update now  |  [u] or [Esc] to close';
  }
  return 'Press [u] or [Esc] to close';
}

export function UpdateModal({ state }: UpdateModalProps) {
  const statusDisplay = getStatusDisplay(state);
  const hint = getHint(state);

  return (
    <OverlayModal title="Update Status" hint={hint}>
      {/* Version info */}
      <Box flexDirection="column" gap={0}>
        <Box>
          <Text dimColor>Current version: </Text>
          <Text bold>v{state.currentVersion}</Text>
        </Box>

        {state.latestVersion && state.latestVersion !== state.currentVersion && (
          <Box>
            <Text dimColor>Latest version:  </Text>
            <Text bold color="green">v{state.latestVersion}</Text>
          </Box>
        )}
      </Box>

      {/* Status line */}
      <Box marginTop={1}>
        {state.status === 'installing' ? (
          <Box gap={1}>
            <Spinner type="dots" />
            <Text color={statusDisplay.color}>{statusDisplay.label}</Text>
          </Box>
        ) : (
          <Box gap={1}>
            <Text>{statusDisplay.icon}</Text>
            <Text color={statusDisplay.color}>{statusDisplay.label}</Text>
          </Box>
        )}
      </Box>

      {/* Additional info based on status */}
      {state.status === 'scheduled' && state.scheduledRestartAt && (
        <Box marginTop={1}>
          <Text dimColor>Restart at: </Text>
          <Text>{formatTime(state.scheduledRestartAt)}</Text>
        </Box>
      )}

      {state.status === 'deferred' && state.deferredUntil && (
        <Box marginTop={1}>
          <Text dimColor>Deferred until: </Text>
          <Text>{formatTime(state.deferredUntil)}</Text>
        </Box>
      )}

      {state.status === 'failed' && state.errorMessage && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">Error:</Text>
          <Text dimColor>{state.errorMessage}</Text>
        </Box>
      )}
    </OverlayModal>
  );
}
