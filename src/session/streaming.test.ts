/**
 * Tests for streaming.ts - typing indicators and task list delegation
 *
 * NOTE: Content flushing tests have been moved to src/operations/executors/content.test.ts
 * since that logic is now handled by ContentExecutor via MessageManager.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { bumpTasksToBottom, startTyping, stopTyping } from './streaming.js';
import {
  findLogicalBreakpoint,
  shouldFlushEarly,
  endsAtBreakpoint,
  getCodeBlockState,
  SOFT_BREAK_THRESHOLD,
  MIN_BREAK_THRESHOLD,
  MAX_LINES_BEFORE_BREAK,
} from '../operations/content-breaker.js';
import type { Session } from './types.js';
import type { PlatformClient } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';

// Mock platform client (minimal version for streaming tests)
function createMockPlatform() {
  return {
    sendTyping: mock(() => {}),
    getFormatter: mock(() => createMockFormatter()),
  } as unknown as PlatformClient;
}

// Create a minimal session for testing
function createTestSession(platform: PlatformClient): Session {
  return {
    platformId: 'test',
    threadId: 'thread1',
    sessionId: 'test:thread1',
    claudeSessionId: 'uuid-123',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform,
    workingDir: '/test',
    claude: null as any,
    currentPostId: null,
    currentPostContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: 'start_post',
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    updateTimer: null,
    typingTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isCancelled: false,
    isResumed: false,
    resumeFailCount: 0,
    wasInterrupted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    messageCount: 0,
    statusBarTimer: null,
    hasClaudeResponded: false,
    isProcessing: false,
    recentEvents: [],
  };
}

// ---------------------------------------------------------------------------
// Typing indicator tests
// ---------------------------------------------------------------------------

describe('startTyping', () => {
  let platform: PlatformClient;
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('starts typing indicator and sets interval', () => {
    startTyping(session);

    expect(platform.sendTyping).toHaveBeenCalledWith('thread1');
    expect(session.typingTimer).not.toBeNull();
  });

  test('does not restart if already typing', () => {
    startTyping(session);
    const firstTimer = session.typingTimer;

    startTyping(session);

    // Timer should be the same (not restarted)
    expect(session.typingTimer).toBe(firstTimer);
    // sendTyping called only once (initial call)
    expect(platform.sendTyping).toHaveBeenCalledTimes(1);
  });
});

describe('stopTyping', () => {
  let platform: PlatformClient;
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('clears typing timer', () => {
    startTyping(session);
    expect(session.typingTimer).not.toBeNull();

    stopTyping(session);

    expect(session.typingTimer).toBeNull();
  });

  test('does nothing if not typing', () => {
    // Should not throw
    stopTyping(session);
    expect(session.typingTimer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task list bumping (delegation to MessageManager)
// ---------------------------------------------------------------------------

describe('bumpTasksToBottom', () => {
  let platform: PlatformClient;
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('delegates to MessageManager when available', async () => {
    const bumpTaskListMock = mock(async () => {});
    session.messageManager = {
      bumpTaskList: bumpTaskListMock,
    } as any;

    await bumpTasksToBottom(session);

    expect(bumpTaskListMock).toHaveBeenCalled();
  });

  test('does nothing when no MessageManager', async () => {
    // No messageManager set
    await bumpTasksToBottom(session);
    // Should not throw
  });
});

// ---------------------------------------------------------------------------
// Logical breakpoint detection tests (content-breaker module)
// ---------------------------------------------------------------------------

describe('findLogicalBreakpoint', () => {
  test('finds tool result marker as highest priority', () => {
    const content = 'Some text\n  ↳ ✓\nMore text\n## Heading';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('tool_marker');
    expect(result?.position).toBe(content.indexOf('  ↳ ✓') + '  ↳ ✓\n'.length);
  });

  test('finds tool error marker', () => {
    const content = 'Some text\n  ↳ ❌ Error\nMore text';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('tool_marker');
  });

  test('finds heading as second priority', () => {
    const content = 'Some text without tool markers\n## New Section\nContent';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('heading');
    expect(result?.position).toBe(content.indexOf('\n## New Section'));
  });

  test('finds h3 headings', () => {
    const content = 'Some text\n### Subsection\nContent';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('heading');
  });

  test('finds code block end as third priority', () => {
    const content = 'Some text\n```typescript\ncode\n```\nMore text';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('code_block_end');
    expect(result?.position).toBe(content.indexOf('```\n') + 4);
  });

  test('finds paragraph break as fourth priority', () => {
    const content = 'Some text without other markers.\n\nNew paragraph starts here.';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('paragraph');
  });

  test('falls back to line break', () => {
    const content = 'First line\nSecond line continues without other markers';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('none');
    expect(result?.position).toBe(content.indexOf('\n') + 1);
  });

  test('returns null for content without breaks', () => {
    const content = 'Single line of content with no breaks at all';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).toBeNull();
  });

  test('respects startPos parameter', () => {
    const content = '  ↳ ✓\nEarly marker\n## Later heading';
    const result = findLogicalBreakpoint(content, 15);
    expect(result?.type).toBe('heading');
  });

  test('respects maxLookAhead parameter', () => {
    const content = 'Short window\n' + 'X'.repeat(600) + '\n## Far heading';
    const result = findLogicalBreakpoint(content, 0, 50);
    expect(result?.type).toBe('none');
  });
});

describe('shouldFlushEarly', () => {
  test('returns true when content exceeds soft threshold', () => {
    const longContent = 'X'.repeat(SOFT_BREAK_THRESHOLD + 1);
    expect(shouldFlushEarly(longContent)).toBe(true);
  });

  test('returns false when content is under threshold', () => {
    const shortContent = 'Short content';
    expect(shouldFlushEarly(shortContent)).toBe(false);
  });

  test('returns true when line count exceeds threshold', () => {
    const manyLines = Array(MAX_LINES_BEFORE_BREAK + 1).fill('Line').join('\n');
    expect(shouldFlushEarly(manyLines)).toBe(true);
  });

  test('returns false for few lines under character threshold', () => {
    const fewLines = 'Line1\nLine2\nLine3';
    expect(shouldFlushEarly(fewLines)).toBe(false);
  });
});

describe('endsAtBreakpoint', () => {
  test('detects tool marker at end', () => {
    expect(endsAtBreakpoint('Some output\n  ↳ ✓')).toBe('tool_marker');
    expect(endsAtBreakpoint('Some output\n  ↳ ✓  ')).toBe('tool_marker');
  });

  test('detects tool error at end', () => {
    expect(endsAtBreakpoint('Output\n  ↳ ❌ Error occurred')).toBe('tool_marker');
  });

  test('detects code block end', () => {
    expect(endsAtBreakpoint('```typescript\ncode\n```')).toBe('code_block_end');
  });

  test('detects paragraph break at end', () => {
    expect(endsAtBreakpoint('Some text\n\n')).toBe('paragraph');
  });

  test('returns none for regular content', () => {
    expect(endsAtBreakpoint('Just regular text')).toBe('none');
    expect(endsAtBreakpoint('Text ending with newline\n')).toBe('none');
  });
});

describe('threshold constants', () => {
  test('SOFT_BREAK_THRESHOLD is reasonable', () => {
    expect(SOFT_BREAK_THRESHOLD).toBeGreaterThan(1000);
    expect(SOFT_BREAK_THRESHOLD).toBeLessThan(5000);
  });

  test('MIN_BREAK_THRESHOLD is reasonable', () => {
    expect(MIN_BREAK_THRESHOLD).toBeGreaterThan(100);
    expect(MIN_BREAK_THRESHOLD).toBeLessThan(SOFT_BREAK_THRESHOLD);
  });

  test('MAX_LINES_BEFORE_BREAK is reasonable', () => {
    expect(MAX_LINES_BEFORE_BREAK).toBeGreaterThan(5);
    expect(MAX_LINES_BEFORE_BREAK).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// Code block state detection tests
// ---------------------------------------------------------------------------

describe('getCodeBlockState', () => {
  test('detects when inside a code block', () => {
    const content = 'Some text\n```typescript\nconst x = 1;\n';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.language).toBe('typescript');
  });

  test('detects when outside a closed code block', () => {
    const content = 'Some text\n```typescript\nconst x = 1;\n```\nMore text';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(false);
  });

  test('detects when inside a diff block', () => {
    const content = 'Edit file.ts\n```diff\n- old line\n+ new line\n';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.language).toBe('diff');
  });

  test('detects code block without language', () => {
    const content = 'Some text\n```\ncode here\n';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.language).toBeUndefined();
  });

  test('tracks position of opening marker', () => {
    const content = 'Prefix\n```typescript\ncode';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.openPosition).toBe(content.indexOf('```typescript'));
  });

  test('handles multiple code blocks correctly', () => {
    const content = '```js\ncode1\n```\ntext\n```python\ncode2';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.language).toBe('python');
  });

  test('handles position in middle of content', () => {
    const content = '```js\ncode\n```\nmore\n```diff\nchanges\n```';
    const pos = content.indexOf('more');
    const result = getCodeBlockState(content, pos);
    expect(result.isInside).toBe(false);
  });

  test('returns false for content without code blocks', () => {
    const content = 'Just regular text without any code blocks';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(false);
  });
});

describe('findLogicalBreakpoint with code blocks', () => {
  test('returns null when inside code block without closing in window', () => {
    const longCode = 'x'.repeat(600);
    const longContent = `Text\n\`\`\`diff\n${longCode}\n\`\`\`\nafter`;
    const result = findLogicalBreakpoint(longContent, 20, 100);
    expect(result).toBeNull();
  });

  test('finds code block end when inside block and closing is within window', () => {
    const content = 'Text\n```diff\n- old\n+ new\n```\nMore text after';
    const result = findLogicalBreakpoint(content, 15);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('code_block_end');
    expect(result?.position).toBeGreaterThan(content.indexOf('```\n'));
  });

  test('does not suggest break inside code block for paragraph markers', () => {
    const content = '```typescript\ncode\n\nmore code\n```';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('code_block_end');
    expect(result?.position).toBe(content.length);
  });

  test('prefers code block end over other markers inside the block', () => {
    const content = '```markdown\n## Heading inside block\n```\noutside';
    const result = findLogicalBreakpoint(content, 0);
    expect(result?.type).toBe('code_block_end');
  });
});
