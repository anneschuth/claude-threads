/**
 * Main App component - root of the Ink UI
 */
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { Header, Platforms, CollapsibleSession, LogPanel } from './components/index.js';
import { RootLayout, Panel, PanelGroup } from './layouts/index.js';
import type { PanelConfig } from './layouts/index.js';
import { Footer } from './components/Footer.js';
import { OverlayModal } from './components/OverlayModal.js';
import { useAppState } from './hooks/useAppState.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import type { AppConfig, SessionInfo, LogEntry, PlatformStatus, ToggleState, ToggleCallbacks, UpdatePanelState } from './types.js';

interface AppProps {
  config: AppConfig;
  onStateReady: (handlers: AppHandlers) => void;
  onResizeReady?: (handler: () => void) => void;
  onQuit?: () => void;
  toggleCallbacks?: ToggleCallbacks;
}

export interface AppHandlers {
  setReady: () => void;
  setShuttingDown: () => void;
  addSession: (session: SessionInfo) => void;
  updateSession: (sessionId: string, updates: Partial<SessionInfo>) => void;
  removeSession: (sessionId: string) => void;
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  setPlatformStatus: (platformId: string, status: Partial<PlatformStatus>) => void;
  setUpdateState: (state: UpdatePanelState) => void;
  getToggles: () => ToggleState;
}

export function App({ config, onStateReady, onResizeReady, onQuit, toggleCallbacks }: AppProps) {
  const {
    state,
    setReady,
    setShuttingDown,
    addSession,
    updateSession,
    removeSession,
    addLog,
    toggleSession,
    setPlatformStatus,
    togglePlatformEnabled,
    getLogsForSession,
    getGlobalLogs,
  } = useAppState(config);

  // Get terminal dimensions for calculating available height
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 24;

  // Resize counter to force re-render on terminal resize (value used indirectly)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [resizeCount, setResizeCount] = React.useState(0);

  // Runtime toggle state - initialized from config
  const [toggles, setToggles] = React.useState<ToggleState>({
    debugMode: process.env.DEBUG === '1',
    skipPermissions: config.skipPermissions,
    chromeEnabled: config.chromeEnabled,
    keepAliveEnabled: config.keepAliveEnabled,
    updateModalVisible: false,
    logsFocused: false,
  });

  // Update panel state - tracks auto-update status
  const [updateState, setUpdateState] = React.useState<UpdatePanelState>({
    status: 'idle',
    currentVersion: config.version,
  });

  // Active modal state for RootLayout
  const [activeModal, setActiveModal] = React.useState<React.ReactNode | null>(null);

  // Toggle handlers - update state and call callbacks
  const handleDebugToggle = React.useCallback(() => {
    setToggles(prev => {
      const newValue = !prev.debugMode;
      // Update process.env.DEBUG
      process.env.DEBUG = newValue ? '1' : '';
      toggleCallbacks?.onDebugToggle?.(newValue);
      return { ...prev, debugMode: newValue };
    });
  }, [toggleCallbacks]);

  const handlePermissionsToggle = React.useCallback(() => {
    setToggles(prev => {
      const newValue = !prev.skipPermissions;
      toggleCallbacks?.onPermissionsToggle?.(newValue);
      return { ...prev, skipPermissions: newValue };
    });
  }, [toggleCallbacks]);

  const handleChromeToggle = React.useCallback(() => {
    setToggles(prev => {
      const newValue = !prev.chromeEnabled;
      toggleCallbacks?.onChromeToggle?.(newValue);
      return { ...prev, chromeEnabled: newValue };
    });
  }, [toggleCallbacks]);

  const handleKeepAliveToggle = React.useCallback(() => {
    setToggles(prev => {
      const newValue = !prev.keepAliveEnabled;
      toggleCallbacks?.onKeepAliveToggle?.(newValue);
      return { ...prev, keepAliveEnabled: newValue };
    });
  }, [toggleCallbacks]);

  // Update modal toggle handler - manages both toggle state and modal content
  const handleUpdateModalToggle = React.useCallback(() => {
    setToggles(prev => {
      const newVisible = !prev.updateModalVisible;
      if (newVisible) {
        setActiveModal(
          <OverlayModal
            title="Update Status"
            hint={getUpdateHint(updateState)}
          >
            <UpdateModalContent state={updateState} />
          </OverlayModal>
        );
      } else {
        setActiveModal(null);
      }
      return { ...prev, updateModalVisible: newVisible };
    });
  }, [updateState]);

  // Logs focus toggle handler
  const handleLogsFocusToggle = React.useCallback(() => {
    setToggles(prev => ({ ...prev, logsFocused: !prev.logsFocused }));
  }, []);

  // Platform toggle handler - toggles enabled state and calls callback
  const handlePlatformToggle = React.useCallback((platformId: string) => {
    const newEnabled = togglePlatformEnabled(platformId);
    toggleCallbacks?.onPlatformToggle?.(platformId, newEnabled);
  }, [togglePlatformEnabled, toggleCallbacks]);

  // Getter for external access to toggle state
  const getToggles = React.useCallback(() => toggles, [toggles]);

  // Expose handlers to the outside world
  // This runs once when the component mounts
  React.useEffect(() => {
    onStateReady({
      setReady,
      setShuttingDown,
      addSession,
      updateSession,
      removeSession,
      addLog,
      setPlatformStatus,
      setUpdateState,
      getToggles,
    });
  }, [onStateReady, setReady, setShuttingDown, addSession, updateSession, removeSession, addLog, setPlatformStatus, setUpdateState, getToggles]);

  // Register resize handler
  React.useEffect(() => {
    if (onResizeReady) {
      onResizeReady(() => setResizeCount((c) => c + 1));
    }
  }, [onResizeReady]);

  // Keep modal content in sync with updateState changes when modal is visible
  React.useEffect(() => {
    if (toggles.updateModalVisible) {
      setActiveModal(
        <OverlayModal
          title="Update Status"
          hint={getUpdateHint(updateState)}
        >
          <UpdateModalContent state={updateState} />
        </OverlayModal>
      );
    }
  }, [updateState, toggles.updateModalVisible]);

  // Get session IDs for keyboard handling
  const sessionIds = Array.from(state.sessions.keys());

  // Get platform IDs for keyboard handling (Shift+1-9)
  const platformIds = Array.from(state.platforms.keys());

  // Handle keyboard input
  useKeyboard({
    sessionIds,
    platformIds,
    onToggle: toggleSession,
    onPlatformToggle: handlePlatformToggle,
    onQuit,
    onDebugToggle: handleDebugToggle,
    onPermissionsToggle: handlePermissionsToggle,
    onChromeToggle: handleChromeToggle,
    onKeepAliveToggle: handleKeepAliveToggle,
    onUpdateModalToggle: handleUpdateModalToggle,
    onLogsFocusToggle: handleLogsFocusToggle,
    onForceUpdate: toggleCallbacks?.onForceUpdate,
    updateModalVisible: toggles.updateModalVisible,
    logsFocused: toggles.logsFocused,
  });

  // Get global logs (not associated with a session)
  const globalLogs = getGlobalLogs();
  const hasSessions = state.sessions.size > 0;

  // Calculate middle height for PanelGroup (matches RootLayout calculation)
  const headerHeight = 5; // Logo (3 lines + border)
  const footerHeight = 2; // Separator + status row
  const middleHeight = Math.max(5, terminalRows - headerHeight - footerHeight);

  // Build the header content (logo + config merged into Header)
  const headerContent = (
    <Header
      version={config.version}
      workingDir={config.workingDir}
      claudeVersion={config.claudeVersion}
    />
  );

  // Build the footer content
  const footerContent = (
    <Footer
      ready={state.ready}
      shuttingDown={state.shuttingDown}
      sessionCount={state.sessions.size}
      toggles={toggles}
      platforms={state.platforms}
      updateState={updateState}
    />
  );

  // Build panel configurations for the middle content
  // Space distribution: platforms (small, fixed), logs (medium), sessions (grows)
  const platformCount = Math.max(1, state.platforms.size);
  const numSessions = state.sessions.size;

  const panels: PanelConfig[] = [
    {
      id: 'platforms',
      minHeight: 1 + platformCount, // Title + one line per platform
      maxHeight: 1 + platformCount, // Fixed size
      priority: 1,
      content: (
        <Panel title="Platforms" count={state.platforms.size}>
          <Platforms platforms={state.platforms} />
        </Panel>
      ),
    },
    {
      id: 'logs',
      minHeight: 4, // Title + at least 3 log lines
      maxHeight: 10, // Don't let logs dominate
      priority: 2,
      content: (
        <Panel title="Logs" count={globalLogs.length} focused={toggles.logsFocused}>
          {toggles.logsFocused && (
            <Text dimColor> - up/down scroll, g/G top/bottom, [l] unfocus</Text>
          )}
          {globalLogs.length > 0 ? (
            <LogPanel logs={globalLogs} focused={toggles.logsFocused} />
          ) : (
            <Text dimColor italic>  No logs yet</Text>
          )}
        </Panel>
      ),
    },
    {
      id: 'sessions',
      minHeight: 1 + Math.max(1, numSessions), // Title + at least 1 line per session
      priority: 3, // Highest - sessions get remaining space
      content: (
        <Panel title="Threads" count={numSessions}>
          {hasSessions ? (
            Array.from(state.sessions.entries()).map(([id, session], index) => (
              <CollapsibleSession
                key={id}
                session={session}
                logs={getLogsForSession(id)}
                expanded={state.expandedSessions.has(id)}
                sessionNumber={index + 1}
              />
            ))
          ) : (
            <Text dimColor italic>  No active threads</Text>
          )}
        </Panel>
      ),
    },
  ];

  return (
    <RootLayout
      header={headerContent}
      footer={footerContent}
      modal={activeModal}
    >
      <PanelGroup availableHeight={middleHeight} panels={panels} />
    </RootLayout>
  );
}

/**
 * Helper function to get the hint text for the update modal
 */
function getUpdateHint(state: UpdatePanelState): string {
  const canUpdate = state.status === 'available' || state.status === 'deferred';
  if (canUpdate) {
    return 'Press [Shift+U] to update now  |  [u] or [Esc] to close';
  }
  return 'Press [u] or [Esc] to close';
}

/**
 * Update modal content component - extracted for use with OverlayModal
 */
function UpdateModalContent({ state }: { state: UpdatePanelState }) {
  return (
    <Box flexDirection="column">
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
        <StatusIcon state={state} />
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
    </Box>
  );
}

/**
 * Status icon component for the update modal
 */
function StatusIcon({ state }: { state: UpdatePanelState }) {
  const { icon, label, color } = getStatusDisplay(state);

  if (state.status === 'installing') {
    return (
      <Box gap={1}>
        <Text color={color}>{label}</Text>
      </Box>
    );
  }

  return (
    <Box gap={1}>
      <Text>{icon}</Text>
      <Text color={color}>{label}</Text>
    </Box>
  );
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
      return { icon: '\u2713', label: 'Up to date', color: 'green' };
    case 'available':
      return { icon: '\uD83C\uDD95', label: 'Update available', color: 'green' };
    case 'scheduled':
      return { icon: '\u23F0', label: 'Restart scheduled', color: 'yellow' };
    case 'installing':
      return { icon: '\uD83D\uDCE6', label: 'Installing...', color: 'cyan' };
    case 'pending_restart':
      return { icon: '\uD83D\uDD04', label: 'Restarting...', color: 'yellow' };
    case 'failed':
      return { icon: '\u274C', label: 'Update failed', color: 'red' };
    case 'deferred':
      return { icon: '\u23F8\uFE0F', label: 'Update deferred', color: 'gray' };
    default:
      return { icon: '?', label: 'Unknown', color: 'gray' };
  }
}

/**
 * Format a date for display
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
