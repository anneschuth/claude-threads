/**
 * Modal component - a centered overlay box
 *
 * Renders a bordered box with a title that overlays the terminal content.
 * In Ink, we achieve this by rendering the modal as a separate Box that
 * uses the full terminal width/height.
 */
import { Box, Text, useStdout } from 'ink';
import type { ReactNode } from 'react';

interface ModalProps {
  /** Modal title displayed in the header */
  title: string;
  /** Content to display inside the modal */
  children: ReactNode;
  /** Hint text shown at the bottom (e.g., "Press u or Esc to close") */
  hint?: string;
}

/**
 * Modal overlay component
 *
 * Renders a centered bordered box. The parent component controls visibility
 * by conditionally rendering the Modal.
 */
export function Modal({ title, children, hint }: ModalProps) {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;

  // Modal dimensions
  const modalWidth = Math.min(50, terminalWidth - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      width={modalWidth}
    >
      {/* Title bar */}
      <Box justifyContent="center" marginBottom={1}>
        <Text color="cyan" bold>{title}</Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column">
        {children}
      </Box>

      {/* Hint at bottom */}
      {hint && (
        <Box justifyContent="center" marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      )}
    </Box>
  );
}
