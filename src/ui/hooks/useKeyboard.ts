/**
 * useKeyboard hook - handle keyboard input for session toggling
 */
import { useInput } from 'ink';

interface UseKeyboardOptions {
  sessionIds: string[];
  onToggle: (sessionId: string) => void;
  onQuit?: () => void;
}

export function useKeyboard({ sessionIds, onToggle, onQuit }: UseKeyboardOptions) {
  useInput((input, _key) => {
    // Number keys 1-9 to toggle sessions
    const num = parseInt(input, 10);
    if (num >= 1 && num <= 9) {
      const sessionId = sessionIds[num - 1];
      if (sessionId) {
        onToggle(sessionId);
      }
    }

    // q to quit (optional)
    if (input === 'q' && onQuit) {
      onQuit();
    }

    // Ctrl+C is handled by Ink automatically
  });
}
