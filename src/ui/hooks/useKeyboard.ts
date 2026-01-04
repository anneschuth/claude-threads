/**
 * useKeyboard hook - handle keyboard input for session toggling and runtime toggles
 */
import { useInput } from 'ink';

interface UseKeyboardOptions {
  sessionIds: string[];
  onToggle: (sessionId: string) => void;
  onQuit?: () => void;
  // Runtime toggle handlers
  onDebugToggle?: () => void;
  onPermissionsToggle?: () => void;
  onChromeToggle?: () => void;
  onKeepAliveToggle?: () => void;
}

export function useKeyboard({
  sessionIds,
  onToggle,
  onQuit,
  onDebugToggle,
  onPermissionsToggle,
  onChromeToggle,
  onKeepAliveToggle,
}: UseKeyboardOptions) {
  useInput((input, key) => {
    // Ctrl+C to quit - handle explicitly since Ink captures it in raw mode
    // Ctrl+C can appear as '\x03' (raw) or 'c' with key.ctrl
    if (input === '\x03' || (input === 'c' && key.ctrl)) {
      if (onQuit) {
        onQuit();
      }
      return;
    }

    // Number keys 1-9 to toggle sessions
    const num = parseInt(input, 10);
    if (num >= 1 && num <= 9) {
      const sessionId = sessionIds[num - 1];
      if (sessionId) {
        onToggle(sessionId);
      }
    }

    // Runtime toggles - d, p, c, k
    switch (input.toLowerCase()) {
      case 'd':
        onDebugToggle?.();
        break;
      case 'p':
        onPermissionsToggle?.();
        break;
      case 'c':
        onChromeToggle?.();
        break;
      case 'k':
        onKeepAliveToggle?.();
        break;
      case 'q':
        onQuit?.();
        break;
    }
  });
}
