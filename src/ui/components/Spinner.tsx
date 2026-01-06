/**
 * Spinner component - wrapper around @inkjs/ui Spinner
 */
import { Box, Text } from 'ink';
import { Spinner as InkSpinner } from '@inkjs/ui';
import type { SpinnerName } from 'cli-spinners';

interface SpinnerProps {
  label?: string;
  /**
   * Type of spinner animation.
   * @default 'simpleDots' - typing-style dots animation (. .. ...)
   */
  type?: SpinnerName;
}

export function Spinner({ label, type = 'simpleDots' }: SpinnerProps) {
  return (
    <Box gap={1}>
      <InkSpinner type={type} />
      {label && <Text dimColor>{label}</Text>}
    </Box>
  );
}
