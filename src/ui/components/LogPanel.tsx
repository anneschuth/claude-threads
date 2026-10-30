/**
 * LogPanel component - displays global log messages with optional scrolling
 * Only shows info/warn/error level (filters out debug noise)
 */
import React from 'react';
import { Box, Text, useBoxMetrics, useInput } from 'ink';
import type { DOMElement } from 'ink';
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
  const viewportRef = React.useRef<DOMElement>(null);
  const contentRef = React.useRef<DOMElement>(null);
  const { clientHeight: viewportHeight } = useBoxMetrics(viewportRef);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  const [scrollTop, setScrollTop] = React.useState(0);

  // Filter out debug logs unless DEBUG mode is enabled
  const isDebug = process.env.DEBUG === '1';
  const displayLogs = logs.filter(log => isDebug || log.level !== 'debug');

  // Keep more logs in scroll buffer for history
  const visibleLogs = displayLogs.slice(-Math.max(maxLines * 3, 100));

  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const offset = Math.min(scrollTop, maxScroll);

  // Follow the newest logs while not focused, so focusing starts at the bottom
  React.useEffect(() => {
    if (!focused) setScrollTop(maxScroll);
  }, [maxScroll, focused]);

  const scrollTo = (target: number) => setScrollTop(Math.min(Math.max(0, target), maxScroll));

  // Handle keyboard input for scrolling when focused
  useInput((input, key) => {
    if (!focused) return;

    if (key.upArrow) {
      scrollTo(offset - 1);
    } else if (key.downArrow) {
      scrollTo(offset + 1);
    } else if (key.pageUp) {
      scrollTo(offset - 5);
    } else if (key.pageDown) {
      scrollTo(offset + 5);
    } else if (input === 'g') {
      scrollTo(0);
    } else if (input === 'G') {
      scrollTo(maxScroll);
    }
  }, { isActive: focused });

  if (visibleLogs.length === 0) {
    return null;
  }

  return (
    <Box ref={viewportRef} flexDirection="column" flexGrow={1} overflow="hidden" contentOffsetY={focused ? offset : maxScroll}>
      <Box ref={contentRef} flexDirection="column" flexShrink={0}>
        {visibleLogs.map((log) => (
          <Box key={log.id}>
            <Text dimColor>[{padComponent(log.component)}]</Text>
            <Text color={getLevelColor(log.level)}> {log.message}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
