/**
 * Header component with ASCII logo and config summary in a bordered box
 *
 * Takes exactly 5 lines:
 * - 3 lines for logo with version, tagline, and config info
 * - 2 lines for top/bottom border (handled by Box)
 */
import { Box, Text } from 'ink';
import type { ClaudeVersionStatus } from '../../claude/version-check.js';

interface HeaderProps {
  version: string;
  workingDir: string;
  claudeVersion: string;
  claudeStatus?: ClaudeVersionStatus;
}

export function Header({ version, workingDir, claudeVersion, claudeStatus }: HeaderProps) {
  return (
    <Box
      borderStyle="round"
      paddingX={1}
      flexDirection="column"
    >
      {/* Line 1: Logo + name + version */}
      <Text>
        <Text color="gray">●─ </Text>
        <Text color="blue">┏━ ━┳━</Text>
        <Text>   </Text>
        <Text bold>claude-threads</Text>
        <Text dimColor> v{version}</Text>
      </Text>
      {/* Line 2: Logo + tagline */}
      <Text>
        <Text color="gray">├─ </Text>
        <Text color="blue">┃   ┃</Text>
        <Text>    </Text>
        <Text dimColor>Chat × Claude Code</Text>
        <Text dimColor> · </Text>
        <Text color="red">♥</Text>
        <Text dimColor> github.com/sponsors/axolotl-systems</Text>
      </Text>
      {/* Line 3: Logo + workdir + Claude version */}
      <Text>
        <Text color="gray">╰─ </Text>
        <Text color="blue">┗━  ╹</Text>
        <Text>    </Text>
        <Text color="cyan">{workingDir}</Text>
        <Text dimColor> | Claude {claudeVersion}</Text>
        {claudeStatus === 'untested' && <Text color="yellow"> ⚠ untested</Text>}
        {claudeStatus === 'incompatible' && <Text color="yellow"> ⚠ unsupported</Text>}
      </Text>
    </Box>
  );
}
