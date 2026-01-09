/**
 * Panel - A single content panel with optional title and scroll support
 *
 * Panels are the building blocks of the middle content area.
 * They can have a title bar with optional count indicator.
 */
import React from 'react';
import { Box, Text } from 'ink';

interface PanelProps {
  /** Panel title displayed in the header */
  title?: string;
  /** Optional count to display as "Title (count)" */
  count?: number;
  /** Fixed height for the panel */
  height?: number;
  /** Minimum height if not fixed (default: 1) */
  minHeight?: number;
  /** Whether this panel is focused (highlights title) */
  focused?: boolean;
  /** Panel content */
  children: React.ReactNode;
}

/**
 * Panel component for displaying content sections
 *
 * When focused, the title is highlighted in cyan.
 * Content area handles overflow by hiding.
 */
export function Panel({
  title,
  count,
  height,
  minHeight = 1,
  focused,
  children,
}: PanelProps) {
  const actualHeight = height ?? minHeight;

  return (
    <Box flexDirection="column" height={actualHeight} overflow="hidden">
      {title && (
        <Box>
          <Text dimColor bold={focused} color={focused ? 'cyan' : undefined}>
            {title}
          </Text>
          {count !== undefined && <Text dimColor> ({count})</Text>}
        </Box>
      )}
      <Box flexDirection="column" overflow="hidden" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
