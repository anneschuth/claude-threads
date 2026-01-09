/**
 * OverlayModal component - centered modal overlay
 *
 * A properly centered modal with double border for prominence.
 * Designed to be rendered in the middle content area of RootLayout.
 */
import React from 'react';
import { Box, Text, useStdout } from 'ink';

interface OverlayModalProps {
  title: string;
  children: React.ReactNode;
  hint?: string;
  width?: number;  // Default: 50
}

export function OverlayModal({ title, children, hint, width = 50 }: OverlayModalProps) {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;
  const modalWidth = Math.min(width, terminalWidth - 4);
  const separatorWidth = modalWidth - 6;  // Account for padding and border

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      width={modalWidth}
    >
      {/* Title */}
      <Box justifyContent="center">
        <Text color="cyan" bold>{title}</Text>
      </Box>

      {/* Separator */}
      <Text dimColor>{'─'.repeat(Math.max(0, separatorWidth))}</Text>

      {/* Content */}
      <Box flexDirection="column" marginY={1}>
        {children}
      </Box>

      {/* Hint */}
      {hint && (
        <>
          <Text dimColor>{'─'.repeat(Math.max(0, separatorWidth))}</Text>
          <Box justifyContent="center">
            <Text dimColor italic>{hint}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
