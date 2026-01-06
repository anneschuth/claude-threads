/**
 * useKeyboard hook - handle keyboard input for session toggling and runtime toggles
 */
import { useInput } from 'ink';

// Map Shift+number characters to their index (0-8 for platforms 1-9)
// On US keyboard: Shift+1='!', Shift+2='@', etc.
const SHIFT_NUMBER_MAP: Record<string, number> = {
  '!': 0, // Shift+1
  '@': 1, // Shift+2
  '#': 2, // Shift+3
  $: 3, // Shift+4
  '%': 4, // Shift+5
  '^': 5, // Shift+6
  '&': 6, // Shift+7
  '*': 7, // Shift+8
  '(': 8, // Shift+9
};

interface UseKeyboardOptions {
  sessionIds: string[];
  platformIds: string[];
  onToggle: (sessionId: string) => void;
  onPlatformToggle?: (platformId: string) => void;
  onQuit?: () => void;
  // Runtime toggle handlers
  onDebugToggle?: () => void;
  onPermissionsToggle?: () => void;
  onChromeToggle?: () => void;
  onKeepAliveToggle?: () => void;
}

export function useKeyboard({
  sessionIds,
  platformIds,
  onToggle,
  onPlatformToggle,
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

    // Shift+number keys to toggle platforms (!, @, #, $, %, ^, &, *, ()
    const platformIndex = SHIFT_NUMBER_MAP[input];
    if (platformIndex !== undefined && onPlatformToggle) {
      const platformId = platformIds[platformIndex];
      if (platformId) {
        onPlatformToggle(platformId);
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
