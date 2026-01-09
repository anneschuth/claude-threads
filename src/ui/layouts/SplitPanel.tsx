/**
 * SplitPanel - Horizontal split layout for side-by-side panels
 */
import React from 'react';
import { Box } from 'ink';

interface SplitPanelProps {
  /** Left panel content */
  left: React.ReactNode;
  /** Right panel content */
  right: React.ReactNode;
  /** Width of left panel (number = characters, string = percentage like "30%") */
  leftWidth?: number | string;
  /** Optional height constraint */
  height?: number;
}

/**
 * Renders two panels side by side with a vertical separator
 */
export function SplitPanel({ left, right, leftWidth = '30%', height }: SplitPanelProps) {
  // Parse width - if it's a percentage string, we'll use it directly
  // For now, Ink doesn't support percentage widths well, so we'll use a fixed character width
  const leftWidthValue = typeof leftWidth === 'string'
    ? parseInt(leftWidth) || 30
    : leftWidth;

  return (
    <Box flexDirection="row" height={height} overflow="hidden">
      {/* Left panel */}
      <Box width={leftWidthValue} flexShrink={0} flexDirection="column" overflow="hidden">
        {left}
      </Box>

      {/* Vertical separator */}
      <Box flexShrink={0} flexDirection="column" marginX={1}>
        {/* The separator will be rendered by the parent or content */}
      </Box>

      {/* Right panel */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {right}
      </Box>
    </Box>
  );
}
