/**
 * Main App component - root of the Ink UI
 */
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { Header, ConfigSummary, Platforms, CollapsibleSession, StatusLine, LogPanel, UpdateModal } from './components/index.js';
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

  // Resize counter to force re-render on terminal resize
  const [resizeCount, setResizeCount] = React.useState(0);

  // Get terminal dimensions for pinning StatusLine to bottom
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 24;

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

  // Update modal toggle handler
  const handleUpdateModalToggle = React.useCallback(() => {
    setToggles(prev => ({ ...prev, updateModalVisible: !prev.updateModalVisible }));
  }, []);

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
  const hasLogs = globalLogs.length > 0;
  const hasSessions = state.sessions.size > 0;

  return (
    <Box flexDirection="column" height={terminalRows}>
      {/* Fixed header at top */}
      <Header version={config.version} />
      <ConfigSummary config={config} />

      {/* Main content area - fills available space */}
      <Box flexDirection="column" flexGrow={1}>
        {/* Platforms section */}
        <Box marginTop={1}>
          <Text dimColor>{'─'.repeat(50)}</Text>
        </Box>
        <Box>
          <Text dimColor bold>Platforms</Text>
          <Text dimColor> ({state.platforms.size})</Text>
        </Box>
        <Platforms platforms={state.platforms} />

        {/* Global logs section */}
        <Box marginTop={1}>
          <Text dimColor>{'─'.repeat(50)}</Text>
        </Box>
        <Box>
          <Text dimColor bold={toggles.logsFocused} color={toggles.logsFocused ? 'cyan' : undefined}>
            Logs
          </Text>
          <Text dimColor> ({globalLogs.length})</Text>
          {toggles.logsFocused && <Text dimColor> - ↑↓ scroll, g/G top/bottom, [l] unfocus</Text>}
        </Box>
        {hasLogs ? (
          <LogPanel logs={globalLogs} maxLines={10} focused={toggles.logsFocused} fillAvailable />
        ) : (
          <Text dimColor italic>  No logs yet</Text>
        )}

        {/* Sessions section */}
        <Box marginTop={1}>
          <Text dimColor>{'─'.repeat(50)}</Text>
        </Box>
        <Box>
          <Text dimColor bold>Threads</Text>
          <Text dimColor> ({state.sessions.size})</Text>
        </Box>
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

        {/* Update modal overlay */}
        {toggles.updateModalVisible && (
          <Box marginTop={1} justifyContent="center">
            <UpdateModal state={updateState} />
          </Box>
        )}
      </Box>

      {/* StatusLine pinned to bottom */}
      <StatusLine
        ready={state.ready}
        shuttingDown={state.shuttingDown}
        sessionCount={state.sessions.size}
        toggles={toggles}
        platforms={state.platforms}
        updateState={updateState}
      />
    </Box>
  );
}
