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
  /** Optional hint text displayed on the right side of the title line */
  hint?: string;
  /** Fixed height for the panel (optional - defaults to filling parent) */
  height?: number;
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
  hint,
  height,
  focused,
  children,
}: PanelProps) {
  // Panel fills its parent's space - don't constrain height unless explicitly set
  return (
    <Box flexDirection="column" height={height} flexGrow={1} overflow="hidden">
      {title && (
        <Box flexShrink={0} justifyContent="space-between">
          <Box>
            <Text dimColor bold={focused} color={focused ? 'cyan' : undefined}>
              {title}
            </Text>
            {count !== undefined && <Text dimColor> ({count})</Text>}
          </Box>
          {hint && <Text dimColor>{hint}</Text>}
        </Box>
      )}
      <Box flexDirection="column" overflow="hidden" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
