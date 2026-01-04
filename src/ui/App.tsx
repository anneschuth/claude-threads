/**
 * Main App component - root of the Ink UI
 */
import React from 'react';
import { Box } from 'ink';
import { Header, ConfigSummary, CollapsibleSession, StatusLine } from './components/index.js';
import { useAppState } from './hooks/useAppState.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import type { AppConfig, SessionInfo, LogEntry, PlatformStatus } from './types.js';

interface AppProps {
  config: AppConfig;
  onStateReady: (handlers: AppHandlers) => void;
}

export interface AppHandlers {
  setReady: () => void;
  addSession: (session: SessionInfo) => void;
  updateSession: (sessionId: string, updates: Partial<SessionInfo>) => void;
  removeSession: (sessionId: string) => void;
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  setPlatformStatus: (platformId: string, status: Partial<PlatformStatus>) => void;
}

export function App({ config, onStateReady }: AppProps) {
  const {
    state,
    setReady,
    addSession,
    updateSession,
    removeSession,
    addLog,
    toggleSession,
    setPlatformStatus,
    getLogsForSession,
  } = useAppState(config);

  // Expose handlers to the outside world
  // This runs once when the component mounts
  React.useEffect(() => {
    onStateReady({
      setReady,
      addSession,
      updateSession,
      removeSession,
      addLog,
      setPlatformStatus,
    });
  }, [onStateReady, setReady, addSession, updateSession, removeSession, addLog, setPlatformStatus]);

  // Get session IDs for keyboard handling
  const sessionIds = Array.from(state.sessions.keys());

  // Handle keyboard input
  useKeyboard({
    sessionIds,
    onToggle: toggleSession,
  });

  // Get platform status for reconnection indicator
  const platforms = Array.from(state.platforms.values());
  const reconnecting = platforms.some((p) => p.reconnecting);
  const reconnectAttempts = platforms.find((p) => p.reconnecting)?.reconnectAttempts || 0;

  return (
    <Box flexDirection="column">
      <Header version={config.version} />
      <ConfigSummary config={config} />

      {/* Sessions */}
      {Array.from(state.sessions.entries()).map(([id, session], index) => (
        <CollapsibleSession
          key={id}
          session={session}
          logs={getLogsForSession(id)}
          expanded={state.expandedSessions.has(id)}
          sessionNumber={index + 1}
        />
      ))}

      <StatusLine
        ready={state.ready}
        botName={config.botName}
        sessionCount={state.sessions.size}
        reconnecting={reconnecting}
        reconnectAttempts={reconnectAttempts}
      />
    </Box>
  );
}
