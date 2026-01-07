/**
 * Main App component - root of the Ink UI
 */
import React from 'react';
import { Box, Static, Text } from 'ink';
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

  // Runtime toggle state - initialized from config
  const [toggles, setToggles] = React.useState<ToggleState>({
    debugMode: process.env.DEBUG === '1',
    skipPermissions: config.skipPermissions,
    chromeEnabled: config.chromeEnabled,
    keepAliveEnabled: config.keepAliveEnabled,
    updateModalVisible: false,
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
    onForceUpdate: toggleCallbacks?.onForceUpdate,
    updateModalVisible: toggles.updateModalVisible,
  });


  // Static content - re-created on resize to fix artifacts
  // Note: Platforms is NOT static because it needs to update on connect/disconnect
  const staticContent = React.useMemo(() => [
    { id: `header-${resizeCount}`, element: <Header version={config.version} /> },
    { id: `config-${resizeCount}`, element: <ConfigSummary config={config} /> },
  ], [config, resizeCount]);

  // Get global logs (not associated with a session)
  const globalLogs = getGlobalLogs();
  const hasLogs = globalLogs.length > 0;
  const hasSessions = state.sessions.size > 0;

  return (
    <Box flexDirection="column">
      {/* Static header - renders once, never re-renders */}
      <Static items={staticContent}>
        {(item) => <Box key={item.id}>{item.element}</Box>}
      </Static>

      {/* Platforms - dynamic, updates on connect/disconnect */}
      <Platforms platforms={state.platforms} />

      {/* Global logs (system messages, keep-alive, etc.) */}
      {hasLogs && (
        <>
          <Box marginTop={1}>
            <Text dimColor>{'─'.repeat(50)}</Text>
          </Box>
          <LogPanel logs={globalLogs} maxLines={10} />
        </>
      )}

      {/* Sessions section */}
      {hasSessions && (
        <>
          <Box marginTop={1}>
            <Text dimColor>{'─'.repeat(50)}</Text>
          </Box>
          <Box marginTop={0}>
            <Text dimColor>Sessions ({state.sessions.size})</Text>
          </Box>
          {Array.from(state.sessions.entries()).map(([id, session], index) => (
            <CollapsibleSession
              key={id}
              session={session}
              logs={getLogsForSession(id)}
              expanded={state.expandedSessions.has(id)}
              sessionNumber={index + 1}
            />
          ))}
        </>
      )}

      <StatusLine
        ready={state.ready}
        shuttingDown={state.shuttingDown}
        sessionCount={state.sessions.size}
        toggles={toggles}
        platforms={state.platforms}
        updateState={updateState}
      />

      {/* Update modal overlay */}
      {toggles.updateModalVisible && (
        <Box marginTop={1} justifyContent="center">
          <UpdateModal state={updateState} />
        </Box>
      )}
    </Box>
  );
}
