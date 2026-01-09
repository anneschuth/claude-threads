/**
 * Header component with ASCII logo and config summary in a bordered box
 *
 * Takes exactly 5 lines:
 * - 3 lines for logo with version, tagline, and config info
 * - 2 lines for top/bottom border (handled by Box)
 */
import { Box, Text } from 'ink';

interface HeaderProps {
  version: string;
  workingDir: string;
  claudeVersion: string;
}

export function Header({ version, workingDir, claudeVersion }: HeaderProps) {
  return (
    <Box
      borderStyle="round"
      paddingX={1}
      flexDirection="column"
    >
      {/* Line 1: Logo + name + version */}
      <Text>
        <Text color="yellow"> ✴</Text>
        <Text> </Text>
        <Text color="blue">▄█▀ ███</Text>
        <Text> </Text>
        <Text color="yellow">✴</Text>
        <Text>   </Text>
        <Text bold>claude-threads</Text>
        <Text dimColor> v{version}</Text>
      </Text>
      {/* Line 2: Logo + tagline */}
      <Text>
        <Text color="yellow">✴</Text>
        <Text>  </Text>
        <Text color="blue">█▀   █</Text>
        <Text>   </Text>
        <Text color="yellow">✴</Text>
        <Text>  </Text>
        <Text dimColor>Chat × Claude Code</Text>
      </Text>
      {/* Line 3: Logo + workdir + Claude version */}
      <Text>
        <Text> </Text>
        <Text color="yellow">✴</Text>
        <Text> </Text>
        <Text color="blue">▀█▄  █</Text>
        <Text>  </Text>
        <Text color="yellow">✴</Text>
        <Text>   </Text>
        <Text color="cyan">{workingDir}</Text>
        <Text dimColor> | Claude {claudeVersion}</Text>
      </Text>
    </Box>
  );
}
