/**
 * LogPanel component - displays global log messages with optional scrolling
 * Only shows info/warn/error level (filters out debug noise)
 */
import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import type { ScrollViewRef } from 'ink-scroll-view';
import type { LogEntry } from '../types.js';

interface LogPanelProps {
  logs: LogEntry[];
  maxLines?: number;
  focused?: boolean;
}

function getLevelColor(level: LogEntry['level']): string {
  switch (level) {
    case 'error':
      return 'red';
    case 'warn':
      return 'yellow';
    case 'debug':
      return 'gray';
    default:
      return 'white';
  }
}

// Pad component name to fixed width for alignment
const COMPONENT_WIDTH = 10;
function padComponent(name: string): string {
  return name.padEnd(COMPONENT_WIDTH);
}

export function LogPanel({ logs, maxLines = 10, focused = false }: LogPanelProps) {
  const scrollRef = React.useRef<ScrollViewRef>(null);
  const { stdout } = useStdout();

  // Filter out debug logs unless DEBUG mode is enabled
  const isDebug = process.env.DEBUG === '1';
  const displayLogs = logs.filter(log => isDebug || log.level !== 'debug');

  // Calculate dynamic height based on terminal size
  // Use about 30% of terminal height for logs (always use dynamic sizing)
  const terminalRows = stdout?.rows ?? 24;
  const dynamicMaxLines = Math.max(maxLines, Math.floor(terminalRows * 0.3));

  // Get the logs to display (last N entries)
  const visibleLogs = displayLogs.slice(-Math.max(dynamicMaxLines * 3, 100)); // Keep more in scroll buffer

  // Handle terminal resize
  React.useEffect(() => {
    const handleResize = () => scrollRef.current?.remeasure();
    stdout?.on('resize', handleResize);
    return () => {
      stdout?.off('resize', handleResize);
    };
  }, [stdout]);

  // Auto-scroll to bottom when new logs arrive (only if not focused/scrolling)
  React.useEffect(() => {
    if (!focused && scrollRef.current) {
      scrollRef.current.scrollToBottom();
    }
  }, [displayLogs.length, focused]);

  // Handle keyboard input for scrolling when focused
  useInput((input, key) => {
    if (!focused) return;

    if (key.upArrow) {
      scrollRef.current?.scrollBy(-1);
    } else if (key.downArrow) {
      scrollRef.current?.scrollBy(1);
    } else if (key.pageUp) {
      scrollRef.current?.scrollBy(-5);
    } else if (key.pageDown) {
      scrollRef.current?.scrollBy(5);
    } else if (input === 'g') {
      scrollRef.current?.scrollToTop();
    } else if (input === 'G') {
      scrollRef.current?.scrollToBottom();
    }
  }, { isActive: focused });

  if (visibleLogs.length === 0) {
    return null;
  }

  // Calculate display height
  const displayHeight = Math.min(visibleLogs.length, dynamicMaxLines);

  return (
    <Box flexDirection="column" height={displayHeight}>
      <ScrollView ref={scrollRef}>
        {visibleLogs.map((log) => (
          <Box key={log.id}>
            <Text dimColor>[{padComponent(log.component)}]</Text>
            <Text color={getLevelColor(log.level)}> {log.message}</Text>
          </Box>
        ))}
      </ScrollView>
    </Box>
  );
}
