/**
 * useAppState hook - central state management for the UI
 */
import { useState, useCallback } from 'react';
import type { AppState, AppConfig, SessionInfo, LogEntry, PlatformStatus } from '../types.js';

let logIdCounter = 0;

export function useAppState(initialConfig: AppConfig) {
  const [state, setState] = useState<AppState>({
    config: initialConfig,
    platforms: new Map(),
    sessions: new Map(),
    logs: [],
    selectedSessionId: null,  // Currently selected session tab
    ready: false,
    shuttingDown: false,
  });

  const setReady = useCallback(() => {
    setState((prev) => ({ ...prev, ready: true }));
  }, []);

  const setShuttingDown = useCallback(() => {
    setState((prev) => ({ ...prev, shuttingDown: true }));
  }, []);

  const addSession = useCallback((session: SessionInfo) => {
    setState((prev) => {
      const sessions = new Map(prev.sessions);
      sessions.set(session.id, session);
      // Auto-select the first session or newly added sessions
      const selectedSessionId = sessions.size === 1 ? session.id : prev.selectedSessionId ?? session.id;
      return { ...prev, sessions, selectedSessionId };
    });
  }, []);

  const updateSession = useCallback((sessionId: string, updates: Partial<SessionInfo>) => {
    setState((prev) => {
      const sessions = new Map(prev.sessions);
      const session = sessions.get(sessionId);
      if (session) {
        sessions.set(sessionId, { ...session, ...updates });
      }
      return { ...prev, sessions };
    });
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setState((prev) => {
      const sessions = new Map(prev.sessions);
      sessions.delete(sessionId);
      // If we removed the selected session, select the first remaining session
      let selectedSessionId = prev.selectedSessionId;
      if (selectedSessionId === sessionId) {
        const remaining = Array.from(sessions.keys());
        selectedSessionId = remaining.length > 0 ? remaining[0] : null;
      }
      return { ...prev, sessions, selectedSessionId };
    });
  }, []);

  const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    const newEntry: LogEntry = {
      ...entry,
      id: `log-${++logIdCounter}`,
      timestamp: new Date(),
    };
    setState((prev) => {
      // Keep last 100 logs per session (or global)
      const logs = [...prev.logs, newEntry].slice(-500);
      return { ...prev, logs };
    });
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    setState((prev) => {
      // Only select if session exists
      if (prev.sessions.has(sessionId)) {
        return { ...prev, selectedSessionId: sessionId };
      }
      return prev;
    });
  }, []);

  const setPlatformStatus = useCallback((platformId: string, status: Partial<PlatformStatus>) => {
    setState((prev) => {
      const platforms = new Map(prev.platforms);
      const current = platforms.get(platformId) || {
        id: platformId,
        displayName: platformId,
        botName: 'bot',
        url: '',
        connected: false,
        reconnecting: false,
        reconnectAttempts: 0,
        enabled: true,  // Platforms start enabled by default
      };
      platforms.set(platformId, { ...current, ...status });
      return { ...prev, platforms };
    });
  }, []);

  const getLogsForSession = useCallback((sessionId: string): LogEntry[] => {
    return state.logs.filter((log) => log.sessionId === sessionId);
  }, [state.logs]);

  const getGlobalLogs = useCallback((): LogEntry[] => {
    return state.logs.filter((log) => !log.sessionId);
  }, [state.logs]);

  // Toggle platform enabled state, returns new enabled state
  const togglePlatformEnabled = useCallback((platformId: string): boolean => {
    let newEnabled = false;
    setState((prev) => {
      const platforms = new Map(prev.platforms);
      const current = platforms.get(platformId);
      if (current) {
        newEnabled = !current.enabled;
        platforms.set(platformId, { ...current, enabled: newEnabled });
      }
      return { ...prev, platforms };
    });
    return newEnabled;
  }, []);

  return {
    state,
    setReady,
    setShuttingDown,
    addSession,
    updateSession,
    removeSession,
    addLog,
    selectSession,
    setPlatformStatus,
    togglePlatformEnabled,
    getLogsForSession,
    getGlobalLogs,
  };
}
