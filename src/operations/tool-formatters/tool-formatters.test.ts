/**
 * Tests for ToolFormatterRegistry and built-in formatters
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ToolFormatterRegistry,
  fileToolsFormatter,
  bashToolFormatter,
  taskToolsFormatter,
  chromeToolsFormatter,
  webToolsFormatter,
  skillToolsFormatter,
  shortenPath,
  parseMcpToolName,
  escapeRegExp,
  escapeCodeBlockContent,
  formatToolForPermission,
  // Internal helpers (exported for testing with underscore prefix)
  _formatToolUse as formatToolUse,
} from './index.js';
import { truncateWithEllipsis } from './utils.js';
import type { PlatformFormatter } from '../../platform/formatter.js';

// Mock formatter for testing
const mockFormatter: PlatformFormatter = {
  formatBold: (text: string) => `**${text}**`,
  formatItalic: (text: string) => `_${text}_`,
  formatCode: (text: string) => `\`${text}\``,
  formatCodeBlock: (text: string, lang?: string) =>
    lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``,
  formatLink: (text: string, url: string) => `[${text}](${url})`,
  formatStrikethrough: (text: string) => `~~${text}~~`,
  formatMarkdown: (text: string) => text,
  formatUserMention: (userId: string) => `@${userId}`,
  formatHorizontalRule: () => '---',
  formatBlockquote: (text: string) => `> ${text}`,
  formatListItem: (text: string) => `- ${text}`,
  formatNumberedListItem: (n: number, text: string) => `${n}. ${text}`,
  formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
  escapeText: (text: string) => text,
  formatTable: (_headers: string[], _rows: string[][]) => '',
  formatKeyValueList: (_items: [string, string, string][]) => '',
};

describe('ToolFormatterRegistry', () => {
  let registry: ToolFormatterRegistry;

  beforeEach(() => {
    registry = new ToolFormatterRegistry();
  });

  describe('register and format', () => {
    it('registers a formatter and uses it', () => {
      registry.register(fileToolsFormatter);

      const result = registry.format('Read', { file_path: '/test/file.ts' }, { formatter: mockFormatter });

      expect(result.display).toContain('Read');
      expect(result.display).toContain('file.ts');
    });

    it('falls back to generic format for unknown tools', () => {
      const result = registry.format('UnknownTool', {}, { formatter: mockFormatter });

      expect(result.display).toContain('UnknownTool');
    });

    it('handles wildcard patterns', () => {
      registry.register(chromeToolsFormatter);

      const result = registry.format(
        'mcp__claude-in-chrome__computer',
        { action: 'screenshot' },
        { formatter: mockFormatter }
      );

      expect(result.display).toContain('Chrome');
      expect(result.display).toContain('screenshot');
    });

    it('hasFormatter returns true for registered tools', () => {
      registry.register(fileToolsFormatter);

      expect(registry.hasFormatter('Read')).toBe(true);
      expect(registry.hasFormatter('Unknown')).toBe(false);
    });
  });

  describe('generic MCP formatting', () => {
    it('formats unknown MCP tools generically', () => {
      const result = registry.format(
        'mcp__custom-server__custom-tool',
        {},
        { formatter: mockFormatter }
      );

      expect(result.display).toContain('custom-tool');
      expect(result.display).toContain('custom-server');
    });
  });
});

describe('File Tools Formatter', () => {
  const options = { formatter: mockFormatter };

  describe('Read', () => {
    it('formats Read tool', () => {
      const result = fileToolsFormatter.format('Read', { file_path: '/path/to/file.ts' }, options);

      expect(result).not.toBeNull();
      expect(result!.display).toContain('📄');
      expect(result!.display).toContain('Read');
      expect(result!.display).toContain('file.ts');
    });

    it('shortens home directory paths', () => {
      const home = process.env.HOME || '/home/user';
      const result = fileToolsFormatter.format('Read', { file_path: `${home}/test.ts` }, options);

      expect(result!.display).toContain('~');
    });
  });

  describe('Edit', () => {
    it('formats Edit tool without diff', () => {
      const result = fileToolsFormatter.format('Edit', { file_path: '/path/file.ts' }, options);

      expect(result!.display).toContain('✏️');
      expect(result!.display).toContain('Edit');
      expect(result!.isDestructive).toBe(true);
    });

    it('includes diff when detailed mode is on', () => {
      const result = fileToolsFormatter.format(
        'Edit',
        {
          file_path: '/path/file.ts',
          old_string: 'const x = 1;',
          new_string: 'const x = 2;',
        },
        { ...options, detailed: true }
      );

      expect(result!.display).toContain('diff');
      expect(result!.display).toContain('-');
      expect(result!.display).toContain('+');
    });
  });

  describe('Write', () => {
    it('formats Write tool', () => {
      const result = fileToolsFormatter.format('Write', { file_path: '/path/file.ts' }, options);

      expect(result!.display).toContain('📝');
      expect(result!.display).toContain('Write');
      expect(result!.isDestructive).toBe(true);
    });

    it('includes preview when detailed mode is on', () => {
      const result = fileToolsFormatter.format(
        'Write',
        {
          file_path: '/path/file.ts',
          content: 'line1\nline2\nline3',
        },
        { ...options, detailed: true }
      );

      expect(result!.display).toContain('3 lines');
      expect(result!.display).toContain('line1');
    });
  });

  describe('Glob', () => {
    it('formats Glob tool', () => {
      const result = fileToolsFormatter.format('Glob', { pattern: '**/*.ts' }, options);

      expect(result!.display).toContain('🔍');
      expect(result!.display).toContain('Glob');
      expect(result!.display).toContain('**/*.ts');
    });
  });

  describe('Grep', () => {
    it('formats Grep tool', () => {
      const result = fileToolsFormatter.format('Grep', { pattern: 'TODO' }, options);

      expect(result!.display).toContain('🔎');
      expect(result!.display).toContain('Grep');
      expect(result!.display).toContain('TODO');
    });
  });
});

describe('Bash Formatter', () => {
  const options = { formatter: mockFormatter };

  it('formats Bash command', () => {
    const result = bashToolFormatter.format('Bash', { command: 'ls -la' }, options);

    expect(result!.display).toContain('💻');
    expect(result!.display).toContain('Bash');
    expect(result!.display).toContain('ls -la');
    expect(result!.isDestructive).toBe(true);
  });

  it('truncates long commands', () => {
    const longCommand = 'x'.repeat(100);
    const result = bashToolFormatter.format('Bash', { command: longCommand }, options);

    expect(result!.display).toContain('...');
    expect(result!.display!.length).toBeLessThan(longCommand.length);
  });

  it('shortens worktree paths in commands', () => {
    const result = bashToolFormatter.format(
      'Bash',
      { command: 'cat /path/to/worktree/file.ts' },
      {
        ...options,
        worktreeInfo: { path: '/path/to/worktree', branch: 'feature' },
      }
    );

    expect(result!.display).toContain('[feature]');
  });
});

describe('Task Tools Formatter', () => {
  const options = { formatter: mockFormatter };

  it('hides TodoWrite', () => {
    const result = taskToolsFormatter.format('TodoWrite', {}, options);

    expect(result!.display).toBeNull();
    expect(result!.hidden).toBe(true);
  });

  it('hides Task', () => {
    const result = taskToolsFormatter.format('Task', {}, options);

    expect(result!.display).toBeNull();
    expect(result!.hidden).toBe(true);
  });

  it('formats EnterPlanMode', () => {
    const result = taskToolsFormatter.format('EnterPlanMode', {}, options);

    expect(result!.display).toContain('📋');
    expect(result!.display).toContain('Planning');
  });

  it('hides ExitPlanMode', () => {
    const result = taskToolsFormatter.format('ExitPlanMode', {}, options);

    expect(result!.display).toBeNull();
    expect(result!.hidden).toBe(true);
  });

  it('hides AskUserQuestion', () => {
    const result = taskToolsFormatter.format('AskUserQuestion', {}, options);

    expect(result!.display).toBeNull();
    expect(result!.hidden).toBe(true);
  });
});

describe('Chrome Tools Formatter', () => {
  const options = { formatter: mockFormatter };

  it('formats computer screenshot', () => {
    const result = chromeToolsFormatter.format(
      'mcp__claude-in-chrome__computer',
      { action: 'screenshot' },
      options
    );

    expect(result!.display).toContain('🌐');
    expect(result!.display).toContain('Chrome');
    expect(result!.display).toContain('screenshot');
  });

  it('formats computer click with coordinates', () => {
    const result = chromeToolsFormatter.format(
      'mcp__claude-in-chrome__computer',
      { action: 'left_click', coordinate: [100, 200] },
      options
    );

    expect(result!.display).toContain('left_click');
    expect(result!.display).toContain('100');
    expect(result!.display).toContain('200');
  });

  it('formats navigate', () => {
    const result = chromeToolsFormatter.format(
      'mcp__claude-in-chrome__navigate',
      { url: 'https://example.com/page' },
      options
    );

    expect(result!.display).toContain('navigate');
    expect(result!.display).toContain('example.com');
  });

  it('formats read_page', () => {
    const result = chromeToolsFormatter.format(
      'mcp__claude-in-chrome__read_page',
      { filter: 'interactive' },
      options
    );

    expect(result!.display).toContain('read_page');
    expect(result!.display).toContain('interactive');
  });

  it('formats find', () => {
    const result = chromeToolsFormatter.format(
      'mcp__claude-in-chrome__find',
      { query: 'login button' },
      options
    );

    expect(result!.display).toContain('find');
    expect(result!.display).toContain('login button');
  });
});

describe('Web Tools Formatter', () => {
  const options = { formatter: mockFormatter };

  it('formats WebFetch', () => {
    const result = webToolsFormatter.format(
      'WebFetch',
      { url: 'https://example.com/api' },
      options
    );

    expect(result!.display).toContain('🌐');
    expect(result!.display).toContain('Fetching');
    expect(result!.display).toContain('example.com');
  });

  it('formats WebSearch', () => {
    const result = webToolsFormatter.format(
      'WebSearch',
      { query: 'typescript best practices' },
      options
    );

    expect(result!.display).toContain('🔍');
    expect(result!.display).toContain('Searching');
    expect(result!.display).toContain('typescript');
  });
});

describe('Skill Tools Formatter', () => {
  const options = { formatter: mockFormatter };

  describe('basic skill invocation', () => {
    it('formats simple skill without namespace', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'commit' },
        options
      );

      expect(result).not.toBeNull();
      expect(result!.display).toContain('⚡');
      expect(result!.display).toContain('**Skill**');
      expect(result!.display).toContain('`/commit`');
    });

    it('formats skill with namespace', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'ralph-loop:ralph-loop' },
        options
      );

      expect(result).not.toBeNull();
      expect(result!.display).toContain('⚡');
      expect(result!.display).toContain('**Skill**');
      expect(result!.display).toContain('`/ralph-loop`');
      expect(result!.display).toContain('_(ralph-loop)_');
    });

    it('formats skill with different namespace and command', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'ms-office-suite:pdf' },
        options
      );

      expect(result).not.toBeNull();
      expect(result!.display).toContain('`/pdf`');
      expect(result!.display).toContain('_(ms-office-suite)_');
    });
  });

  describe('skill with arguments', () => {
    it('formats skill with short arguments', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'review-pr', args: '123' },
        options
      );

      expect(result).not.toBeNull();
      expect(result!.display).toContain('`/review-pr`');
      expect(result!.display).toContain('"123"');
    });

    it('formats skill with longer arguments', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'ralph-loop:ralph-loop', args: 'Build a REST API for todos' },
        options
      );

      expect(result).not.toBeNull();
      expect(result!.display).toContain('`/ralph-loop`');
      expect(result!.display).toContain('"Build a REST API for todos"');
    });

    it('truncates very long arguments', () => {
      const longArgs = 'a'.repeat(100);
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'commit', args: longArgs },
        options
      );

      expect(result).not.toBeNull();
      expect(result!.display).toContain('...');
      // Should be truncated to ~80 chars
      expect(result!.display!.length).toBeLessThan(150);
    });
  });

  describe('permission text', () => {
    it('includes full skill name in permission text', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'ralph-loop:ralph-loop', args: 'Build API' },
        options
      );

      expect(result).not.toBeNull();
      expect(result!.permissionText).toContain('`ralph-loop:ralph-loop`');
      expect(result!.permissionText).toContain('with args: "Build API"');
    });

    it('permission text without args', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'commit' },
        options
      );

      expect(result).not.toBeNull();
      expect(result!.permissionText).toContain('`commit`');
      expect(result!.permissionText).not.toContain('with args');
    });
  });

  describe('edge cases', () => {
    it('handles missing skill name', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        {},
        options
      );

      expect(result).not.toBeNull();
      expect(result!.display).toContain('`/unknown`');
    });

    it('handles empty args', () => {
      const result = skillToolsFormatter.format(
        'Skill',
        { skill: 'commit', args: '' },
        options
      );

      expect(result).not.toBeNull();
      // Empty args should not be displayed
      expect(result!.display).not.toContain('""');
    });

    it('returns null for non-Skill tools', () => {
      const result = skillToolsFormatter.format(
        'NotSkill',
        { skill: 'commit' },
        options
      );

      expect(result).toBeNull();
    });
  });

  describe('registry integration', () => {
    it('is properly registered in the registry', () => {
      const registry = new ToolFormatterRegistry();
      registry.register(skillToolsFormatter);

      expect(registry.hasFormatter('Skill')).toBe(true);
    });

    it('formats through the default registry', () => {
      // The default registry should have skillToolsFormatter registered
      const result = formatToolUse('Skill', { skill: 'commit' }, mockFormatter);

      expect(result).not.toBeNull();
      expect(result).toContain('⚡');
      expect(result).toContain('Skill');
      expect(result).toContain('/commit');
    });
  });
});

describe('Utility Functions', () => {
  describe('shortenPath', () => {
    it('replaces home directory with ~', () => {
      const home = process.env.HOME || '/home/user';
      const result = shortenPath(`${home}/documents/file.ts`);

      expect(result).toStartWith('~');
      expect(result).toContain('documents/file.ts');
    });

    it('uses worktree context when provided', () => {
      const result = shortenPath('/worktree/path/src/file.ts', undefined, {
        path: '/worktree/path',
        branch: 'feature-branch',
      });

      expect(result).toBe('[feature-branch]/src/file.ts');
    });

    it('shortens long worktree paths from ~/.claude-threads/worktrees/', () => {
      // This tests the actual format of worktree directories created by claude-threads
      const worktreePath = '/Users/anneschuth/.claude-threads/worktrees/Users-anneschuth-claude-threads--refactor-platform-abstraction-layer-c7287c11';
      const filePath = `${worktreePath}/src/operations/tool-formatters/file.ts`;

      const result = shortenPath(filePath, undefined, {
        path: worktreePath,
        branch: 'refactor/platform-abstraction-layer',
      });

      expect(result).toBe('[refactor/platform-abstraction-layer]/src/operations/tool-formatters/file.ts');
    });

    it('shortens exact worktree path match', () => {
      const worktreePath = '/Users/anneschuth/.claude-threads/worktrees/Users-anneschuth-claude-threads--branch-abc12345';

      const result = shortenPath(worktreePath, undefined, {
        path: worktreePath,
        branch: 'feature/my-branch',
      });

      expect(result).toBe('[feature/my-branch]/');
    });

    it('handles empty path', () => {
      expect(shortenPath('')).toBe('');
    });
  });

  describe('parseMcpToolName', () => {
    it('parses valid MCP tool names', () => {
      const result = parseMcpToolName('mcp__server__tool');

      expect(result).not.toBeNull();
      expect(result!.server).toBe('server');
      expect(result!.tool).toBe('tool');
    });

    it('handles tool names with multiple underscores', () => {
      const result = parseMcpToolName('mcp__server__tool__with__underscores');

      expect(result).not.toBeNull();
      expect(result!.server).toBe('server');
      expect(result!.tool).toBe('tool__with__underscores');
    });

    it('returns null for non-MCP tools', () => {
      expect(parseMcpToolName('Read')).toBeNull();
      expect(parseMcpToolName('Bash')).toBeNull();
    });

    it('returns null for malformed MCP names', () => {
      expect(parseMcpToolName('mcp__')).toBeNull();
      expect(parseMcpToolName('mcp__server')).toBeNull();
    });
  });

  describe('escapeRegExp', () => {
    it('escapes special regex characters', () => {
      expect(escapeRegExp('.*+?^${}()|[]\\'))
        .toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
    });

    it('leaves normal characters unchanged', () => {
      expect(escapeRegExp('abc123')).toBe('abc123');
    });

    it('handles empty string', () => {
      expect(escapeRegExp('')).toBe('');
    });

    it('escapes path with special characters', () => {
      expect(escapeRegExp('/path/to/file.ts')).toBe('/path/to/file\\.ts');
    });
  });

  describe('truncateWithEllipsis', () => {
    it('returns original string if shorter than max', () => {
      expect(truncateWithEllipsis('short', 10)).toBe('short');
    });

    it('returns original string if equal to max', () => {
      expect(truncateWithEllipsis('exact', 5)).toBe('exact');
    });

    it('truncates and adds ellipsis if longer than max', () => {
      expect(truncateWithEllipsis('this is a long string', 10)).toBe('this is a ...');
    });

    it('handles empty string', () => {
      expect(truncateWithEllipsis('', 10)).toBe('');
    });

    it('handles max of 0', () => {
      expect(truncateWithEllipsis('test', 0)).toBe('...');
    });
  });

  describe('escapeCodeBlockContent', () => {
    it('escapes triple backticks', () => {
      expect(escapeCodeBlockContent('```code```')).toBe('` ``code` ``');
    });

    it('leaves normal content unchanged', () => {
      expect(escapeCodeBlockContent('normal content')).toBe('normal content');
    });

    it('handles multiple triple backticks', () => {
      expect(escapeCodeBlockContent('```a``` and ```b```'))
        .toBe('` ``a` `` and ` ``b` ``');
    });

    it('handles single and double backticks unchanged', () => {
      expect(escapeCodeBlockContent('`single` and ``double``'))
        .toBe('`single` and ``double``');
    });

    it('handles empty string', () => {
      expect(escapeCodeBlockContent('')).toBe('');
    });
  });
});

describe('Wrapper Functions', () => {
  const _options = { formatter: mockFormatter };

  describe('formatToolUse', () => {
    it('formats tool for display', () => {
      const result = formatToolUse('Read', { file_path: '/test/file.ts' }, mockFormatter);

      expect(result).not.toBeNull();
      expect(result).toContain('Read');
      expect(result).toContain('file.ts');
    });

    it('returns null for hidden tools', () => {
      const result = formatToolUse('TodoWrite', {}, mockFormatter);
      expect(result).toBeNull();
    });

    it('passes detailed option through', () => {
      const result = formatToolUse(
        'Edit',
        { file_path: '/test.ts', old_string: 'a', new_string: 'b' },
        mockFormatter,
        { detailed: true }
      );

      expect(result).not.toBeNull();
      expect(result).toContain('diff');
    });

    it('passes worktreeInfo option through', () => {
      const result = formatToolUse(
        'Read',
        { file_path: '/worktree/path/file.ts' },
        mockFormatter,
        { worktreeInfo: { path: '/worktree/path', branch: 'feature' } }
      );

      expect(result).toContain('[feature]');
    });
  });

  describe('formatToolForPermission', () => {
    it('formats tool for permission prompt', () => {
      const result = formatToolForPermission('Read', { file_path: '/test.ts' }, mockFormatter);

      expect(result).toContain('Read');
    });

    it('returns tool name as fallback', () => {
      // For unknown tools, should return permissionText or tool name
      const result = formatToolForPermission('UnknownTool', {}, mockFormatter);

      expect(result).toContain('UnknownTool');
    });

    it('uses permissionText over display', () => {
      // Edit tool has different permissionText (no diff)
      const result = formatToolForPermission(
        'Edit',
        { file_path: '/test.ts', old_string: 'a', new_string: 'b' },
        mockFormatter
      );

      expect(result).not.toContain('diff');
      expect(result).toContain('Edit');
    });

    it('passes worktreeInfo for path shortening', () => {
      const result = formatToolForPermission(
        'Write',
        { file_path: '/worktree/file.ts' },
        mockFormatter,
        { worktreeInfo: { path: '/worktree', branch: 'main' } }
      );

      expect(result).toContain('[main]');
    });
  });
});
