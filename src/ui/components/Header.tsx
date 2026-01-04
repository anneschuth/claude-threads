/**
 * Header component with ASCII logo in a bordered box
 */
import { Box, Text } from 'ink';

interface HeaderProps {
  version: string;
}

export function Header({ version }: HeaderProps) {
  return (
    <Box
      borderStyle="round"
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color="yellow"> </Text>
        <Text color="blue">▄█▀ ███</Text>
        <Text color="yellow"> </Text>
        <Text>   </Text>
        <Text bold>claude-threads</Text>
        <Text dimColor>  v{version}</Text>
      </Box>
      <Box>
        <Text color="yellow"></Text>
        <Text color="blue">  █▀   █</Text>
        <Text>   </Text>
        <Text color="yellow"></Text>
        <Text>  </Text>
        <Text dimColor>Chat × Claude Code</Text>
      </Box>
      <Box>
        <Text> </Text>
        <Text color="yellow"></Text>
        <Text> </Text>
        <Text color="blue">▀█▄  █</Text>
        <Text>  </Text>
        <Text color="yellow"></Text>
      </Box>
    </Box>
  );
}
