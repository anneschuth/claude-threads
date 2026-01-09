/**
 * RootLayout - Main layout container for the claude-threads UI
 *
 * Provides a fixed header/footer with flexible middle content area.
 * Structure:
 * - Header: Fixed at top (logo + config), never scrolls
 * - Middle: Flexible area that handles overflow, can show modal overlay
 * - Footer: Fixed at bottom (status line), never scrolls
 */
import React from 'react';
import { Box, useStdout } from 'ink';

interface RootLayoutProps {
  /** Header content (logo, config summary) */
  header: React.ReactNode;
  /** Footer content (status line) */
  footer: React.ReactNode;
  /** Optional modal content - when set, replaces middle content */
  modal?: React.ReactNode;
  /** Main content for the middle area */
  children: React.ReactNode;
}

/**
 * Root layout component that manages the terminal's vertical space
 *
 * - Header and footer have fixed heights and never shrink
 * - Middle area takes remaining space and handles overflow
 * - When modal is provided, it replaces the middle content (centered)
 */
export function RootLayout({ header, footer, modal, children }: RootLayoutProps) {
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 24;
  const terminalCols = stdout?.columns ?? 80;

  // Header and footer have fixed heights
  const headerHeight = 5; // Logo (3 lines + border)
  const footerHeight = 2; // Separator + status row
  const middleHeight = Math.max(5, terminalRows - headerHeight - footerHeight);

  return (
    <Box flexDirection="column" height={terminalRows} width={terminalCols}>
      {/* Header - fixed, never shrinks */}
      <Box flexShrink={0} height={headerHeight}>
        {header}
      </Box>

      {/* Middle - modal or content */}
      <Box
        flexGrow={1}
        height={middleHeight}
        overflow="hidden"
        justifyContent={modal ? 'center' : 'flex-start'}
        alignItems={modal ? 'center' : 'stretch'}
      >
        {modal ?? children}
      </Box>

      {/* Footer - fixed, never shrinks */}
      <Box flexShrink={0} height={footerHeight}>
        {footer}
      </Box>
    </Box>
  );
}
