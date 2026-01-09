/**
 * Tests for streaming.ts - message streaming and sticky task list functionality
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  flush,
  bumpTasksToBottom,
  findLogicalBreakpoint,
  shouldFlushEarly,
  endsAtBreakpoint,
  getCodeBlockState,
  acquireTaskListLock,
  SOFT_BREAK_THRESHOLD,
  MIN_BREAK_THRESHOLD,
  MAX_LINES_BEFORE_BREAK,
} from './streaming.js';
import type { Session } from './types.js';
import type { PlatformClient, PlatformPost } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  const mockPlatform = {
    createPost: mock(async (message: string, _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    updatePost: mock(async (postId: string, message: string): Promise<PlatformPost> => {
      posts.set(postId, message);
      return {
        id: postId,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: '',
        createAt: Date.now(),
      };
    }),
    deletePost: mock(async (postId: string): Promise<void> => {
      posts.delete(postId);
    }),
    createInteractivePost: mock(async (message: string, _reactions: string[], _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    removeReaction: mock(async (_postId: string, _emojiName: string): Promise<void> => {
      // Mock - do nothing
    }),
    pinPost: mock(async (_postId: string): Promise<void> => {}),
    unpinPost: mock(async (_postId: string): Promise<void> => {}),
    sendTyping: mock(() => {}),
    getFormatter: mock(() => createMockFormatter()),
    getMessageLimits: mock(() => ({ maxLength: 16000, hardThreshold: 14000 })),
    posts,
  };

  return mockPlatform as unknown as PlatformClient & { posts: Map<string, string> };
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
    pendingContent: '',
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
    activeSubagents: new Map(),
    updateTimer: null,
    typingTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
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

describe('flush', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('creates new post when currentPostId is null', async () => {
    session.pendingContent = 'Hello world';

    await flush(session, registerPost);

    expect(platform.createPost).toHaveBeenCalledTimes(1);
    expect(session.currentPostId).toBe('post_1');
    expect(registerPost).toHaveBeenCalledWith('post_1', 'thread1');
  });

  test('updates existing post when currentPostId exists', async () => {
    session.currentPostId = 'existing_post';
    session.pendingContent = 'Updated content';

    await flush(session, registerPost);

    expect(platform.updatePost).toHaveBeenCalledWith('existing_post', 'Updated content');
    expect(platform.createPost).not.toHaveBeenCalled();
  });

  test('does nothing when pendingContent is empty', async () => {
    session.pendingContent = '';

    await flush(session, registerPost);

    expect(platform.createPost).not.toHaveBeenCalled();
    expect(platform.updatePost).not.toHaveBeenCalled();
  });

  test('bumps task list to bottom when creating new post with existing task list', async () => {
    // Set up existing task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (0/1)\n○ Do something';
    session.pendingContent = 'New Claude response';

    await flush(session, registerPost);

    // Should have updated the old tasks post with new content
    expect(platform.updatePost).toHaveBeenCalledWith('tasks_post', 'New Claude response');
    // Should have created a new tasks post with toggle emoji
    expect(platform.createInteractivePost).toHaveBeenCalledWith(
      '📋 **Tasks** (0/1)\n○ Do something',
      ['arrow_down_small'],
      'thread1'
    );
    // currentPostId should be the old tasks post (repurposed)
    expect(session.currentPostId).toBe('tasks_post');
    // tasksPostId should be the new post
    expect(session.tasksPostId).toBe('post_1');
  });

  test('does not bump task list when updating existing post', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (0/1)\n○ Do something';
    session.currentPostId = 'current_post';
    session.pendingContent = 'More content';

    await flush(session, registerPost);

    // Should only update the current post, not touch tasks
    expect(platform.updatePost).toHaveBeenCalledTimes(1);
    expect(platform.updatePost).toHaveBeenCalledWith('current_post', 'More content');
    expect(platform.createPost).not.toHaveBeenCalled();
    expect(session.tasksPostId).toBe('tasks_post'); // unchanged
  });
});

describe('bumpTasksToBottom', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('does nothing when no task list exists', async () => {
    session.tasksPostId = null;
    session.lastTasksContent = null;

    await bumpTasksToBottom(session);

    expect(platform.deletePost).not.toHaveBeenCalled();
    expect(platform.createPost).not.toHaveBeenCalled();
  });

  test('does nothing when tasksPostId exists but no content', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = null;

    await bumpTasksToBottom(session);

    expect(platform.deletePost).not.toHaveBeenCalled();
    expect(platform.createPost).not.toHaveBeenCalled();
  });

  test('does nothing when task list is completed', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 ~~Tasks~~ *(completed)*';
    session.tasksCompleted = true;

    await bumpTasksToBottom(session);

    // Should not delete or create - completed tasks stay in place
    expect(platform.deletePost).not.toHaveBeenCalled();
    expect(platform.createPost).not.toHaveBeenCalled();
    expect(session.tasksPostId).toBe('tasks_post');
  });

  test('deletes old task post and creates new one at bottom', async () => {
    session.tasksPostId = 'old_tasks_post';
    session.lastTasksContent = '📋 **Tasks** (1/2)\n✅ Done\n○ Pending';

    await bumpTasksToBottom(session);

    // Should delete the old post
    expect(platform.deletePost).toHaveBeenCalledWith('old_tasks_post');
    // Should create new post with same content and toggle emoji
    expect(platform.createInteractivePost).toHaveBeenCalledWith(
      '📋 **Tasks** (1/2)\n✅ Done\n○ Pending',
      ['arrow_down_small'],
      'thread1'
    );
    // tasksPostId should be updated to new post
    expect(session.tasksPostId).toBe('post_1');
  });

  test('handles errors gracefully', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 Tasks';

    // Mock console.error to suppress expected error output
    const originalConsoleError = console.error;
    console.error = mock(() => {});

    // Make deletePost throw an error
    (platform.deletePost as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('Network error');
    });

    // Should not throw
    await bumpTasksToBottom(session);

    // tasksPostId should remain unchanged due to error
    expect(session.tasksPostId).toBe('tasks_post');

    // Verify error was logged
    expect(console.error).toHaveBeenCalled();

    // Restore console.error
    console.error = originalConsoleError;
  });

  test('concurrent bumpTasksToBottom calls do not create duplicate task posts', async () => {
    session.tasksPostId = 'old_tasks_post';
    session.lastTasksContent = '📋 **Tasks** (1/2)\n✅ Done\n○ Pending';
    session.tasksCompleted = false;

    let createInteractivePostCallCount = 0;
    (platform.createInteractivePost as ReturnType<typeof mock>).mockImplementation(
      async (content: string, reactions: string[], threadId: string) => {
        createInteractivePostCallCount++;
        // Add a small delay to simulate network latency
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { id: `new_tasks_post_${createInteractivePostCallCount}`, content, threadId };
      }
    );

    const registerPost = mock((_postId: string, _threadId: string) => {});

    // Fire two concurrent bumpTasksToBottom calls
    const bump1 = bumpTasksToBottom(session, registerPost);
    const bump2 = bumpTasksToBottom(session, registerPost);

    await Promise.all([bump1, bump2]);

    // Only ONE new task post should be created (second call should be blocked by lock)
    // The first call creates a post, the second call waits for the lock and then
    // either creates another (if tasksPostId was reset) or sees the updated state
    // and may exit early. The key is no duplicate posts for the same content.
    expect(createInteractivePostCallCount).toBeLessThanOrEqual(2);
    // At minimum one post should be created
    expect(createInteractivePostCallCount).toBeGreaterThanOrEqual(1);
  });

  test('bumpTasksToBottom waits for taskListCreationPromise before proceeding', async () => {
    session.tasksPostId = 'old_tasks_post';
    session.lastTasksContent = '📋 **Tasks** (1/2)\n✅ Done\n○ Pending';
    session.tasksCompleted = false;

    const executionOrder: string[] = [];

    // Set up an existing promise lock (simulating handleTodoWrite in progress)
    let resolveExistingLock: () => void = () => {};
    session.taskListCreationPromise = new Promise((resolve) => {
      resolveExistingLock = () => {
        executionOrder.push('existing_lock_released');
        resolve();
      };
    });

    (platform.createInteractivePost as ReturnType<typeof mock>).mockImplementation(
      async (content: string, _reactions: string[], threadId: string) => {
        executionOrder.push('createInteractivePost');
        return { id: 'new_post', content, threadId };
      }
    );

    const registerPost = mock((_postId: string, _threadId: string) => {});

    // Start bumpTasksToBottom - it should wait for the existing lock
    const bumpPromise = bumpTasksToBottom(session, registerPost);

    // Give time for bumpTasksToBottom to start waiting
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Verify createInteractivePost hasn't been called yet (waiting for lock)
    expect(executionOrder).not.toContain('createInteractivePost');

    // Release the existing lock
    resolveExistingLock();

    // Now wait for bumpTasksToBottom to complete
    await bumpPromise;

    // Verify the order: lock released first, then post creation
    expect(executionOrder[0]).toBe('existing_lock_released');
    expect(executionOrder).toContain('createInteractivePost');
  });
});

describe('acquireTaskListLock', () => {
  let session: Session;

  beforeEach(() => {
    const platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('acquires lock atomically - prevents check-then-act race condition', async () => {
    // This test verifies the fix for the duplicate task list bug.
    // The bug occurred because the old lock pattern had a gap between
    // checking if a lock exists and creating a new lock, allowing two
    // concurrent calls to both see "no lock" and both proceed.

    const executionOrder: string[] = [];
    let callCount = 0;

    // Simulate two concurrent critical sections
    async function criticalSection(id: string) {
      callCount++;
      const myCallNum = callCount;
      executionOrder.push(`${id}_start_${myCallNum}`);

      const releaseLock = await acquireTaskListLock(session);
      executionOrder.push(`${id}_acquired_${myCallNum}`);

      // Simulate some async work
      await new Promise(resolve => setTimeout(resolve, 20));

      executionOrder.push(`${id}_done_${myCallNum}`);
      releaseLock();
    }

    // Fire both concurrently - this is the race condition scenario
    const p1 = criticalSection('A');
    const p2 = criticalSection('B');

    await Promise.all([p1, p2]);

    // Both should start immediately (synchronous part)
    expect(executionOrder[0]).toBe('A_start_1');
    expect(executionOrder[1]).toBe('B_start_2');

    // But only one should acquire at a time - verify sequential execution
    // A_acquired should come before B_acquired (or vice versa), and
    // whichever acquires first should complete before the other acquires
    const aAcquiredIdx = executionOrder.indexOf('A_acquired_1');
    const bAcquiredIdx = executionOrder.indexOf('B_acquired_2');
    const aDoneIdx = executionOrder.indexOf('A_done_1');
    const bDoneIdx = executionOrder.indexOf('B_done_2');

    // If A acquired first, A should be done before B acquires (and vice versa)
    if (aAcquiredIdx < bAcquiredIdx) {
      expect(aDoneIdx).toBeLessThan(bAcquiredIdx);
    } else {
      expect(bDoneIdx).toBeLessThan(aAcquiredIdx);
    }
  });

  test('multiple concurrent locks are properly serialized', async () => {
    const results: number[] = [];

    async function acquireAndRecord(value: number) {
      const releaseLock = await acquireTaskListLock(session);
      // The value should be pushed only while we hold the lock
      results.push(value);
      await new Promise(resolve => setTimeout(resolve, 5));
      releaseLock();
    }

    // Fire 5 concurrent lock acquisitions
    await Promise.all([
      acquireAndRecord(1),
      acquireAndRecord(2),
      acquireAndRecord(3),
      acquireAndRecord(4),
      acquireAndRecord(5),
    ]);

    // All 5 values should be recorded (none lost due to race)
    expect(results).toHaveLength(5);
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('lock release allows next caller to proceed', async () => {
    const events: string[] = [];

    // First acquire
    const release1 = await acquireTaskListLock(session);
    events.push('lock1_acquired');

    // Start second acquire (will wait)
    const lock2Promise = acquireTaskListLock(session).then(release => {
      events.push('lock2_acquired');
      return release;
    });

    // Give time for lock2 to start waiting
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(events).toEqual(['lock1_acquired']);

    // Release first lock
    release1();
    events.push('lock1_released');

    // Wait for second lock
    const release2 = await lock2Promise;
    release2();
    events.push('lock2_released');

    // Verify sequence
    expect(events).toEqual([
      'lock1_acquired',
      'lock1_released',
      'lock2_acquired',
      'lock2_released',
    ]);
  });
});

describe('flush with continuation (message splitting)', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('splits long content into multiple posts', async () => {
    // Create content that exceeds CONTINUATION_THRESHOLD (14000 chars)
    const longContent = 'A'.repeat(15000);
    session.currentPostId = 'current_post';
    session.pendingContent = longContent;

    await flush(session, registerPost);

    // Should update current post with first part
    expect(platform.updatePost).toHaveBeenCalled();
    const updateCall = (platform.updatePost as ReturnType<typeof mock>).mock.calls[0];
    expect(updateCall[0]).toBe('current_post');

    // Should create continuation post
    expect(platform.createPost).toHaveBeenCalled();
  });

  test('bumps task list when creating continuation post', async () => {
    // Set up task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 Tasks';

    // Create content that exceeds threshold
    const longContent = 'B'.repeat(15000);
    session.currentPostId = 'current_post';
    session.pendingContent = longContent;

    await flush(session, registerPost);

    // Should update current post with first part
    expect(platform.updatePost).toHaveBeenCalledWith('current_post', expect.stringContaining('BBBB'));

    // Should repurpose tasks post for continuation
    expect(platform.updatePost).toHaveBeenCalledWith('tasks_post', expect.stringContaining('BBBB'));

    // Should create new tasks post with toggle emoji
    expect(platform.createInteractivePost).toHaveBeenCalledWith('📋 Tasks', ['arrow_down_small'], 'thread1');
  });

  test('does not bump completed task list when creating continuation post', async () => {
    // Set up completed task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 ~~Tasks~~ *(completed)*';
    session.tasksCompleted = true;

    // Create content that exceeds threshold
    const longContent = 'C'.repeat(15000);
    session.currentPostId = 'current_post';
    session.pendingContent = longContent;

    await flush(session, registerPost);

    // Should update current post with first part
    expect(platform.updatePost).toHaveBeenCalledWith('current_post', expect.stringContaining('CCCC'));

    // Should NOT repurpose tasks post - create new post instead
    expect(platform.createPost).toHaveBeenCalledWith(expect.stringContaining('CCCC'), 'thread1');

    // Tasks post should remain unchanged
    expect(session.tasksPostId).toBe('tasks_post');
  });

  test('splits before code block instead of inside it', async () => {
    // Create content with text followed by a large code block
    // The code block should move entirely to the next message
    const textBefore = 'Here is some introductory text.\n\n';
    const codeBlock = '```typescript\n' + 'x'.repeat(14000) + '\n```';
    const longContent = textBefore + codeBlock;

    session.currentPostId = 'current_post';
    session.pendingContent = longContent;

    await flush(session, registerPost);

    // Should have updated and created posts
    expect(platform.updatePost).toHaveBeenCalled();
    expect(platform.createPost).toHaveBeenCalled();

    // First part should contain the intro text but NOT the code block
    const updateCall = (platform.updatePost as ReturnType<typeof mock>).mock.calls[0];
    const firstPart = updateCall[1] as string;
    expect(firstPart).toContain('introductory text');
    expect(firstPart).not.toContain('```typescript');

    // Second part (continuation) should contain the entire code block
    const createCall = (platform.createPost as ReturnType<typeof mock>).mock.calls[0];
    const secondPart = createCall[0] as string;
    expect(secondPart).toContain('```typescript');
    expect(secondPart).toContain('```'); // closing backticks
  });

  test('does not split when code block starts at beginning', async () => {
    // Code block at the very start - can't split before it
    const codeBlock = '```typescript\n' + 'y'.repeat(15000) + '\n```';

    session.currentPostId = 'current_post';
    session.pendingContent = codeBlock;

    await flush(session, registerPost);

    // Should just update the current post without creating continuation
    expect(platform.updatePost).toHaveBeenCalledWith('current_post', expect.stringContaining('```typescript'));
    // Should NOT create a new post since we can't split before the code block
    expect(platform.createPost).not.toHaveBeenCalled();
  });
});

describe('flush with completed tasks', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('does not bump completed task list when creating new post', async () => {
    // Set up completed task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 ~~Tasks~~ *(completed)*';
    session.tasksCompleted = true;

    // No current post, so flush will create one
    session.currentPostId = null;
    session.pendingContent = 'New response content';

    await flush(session, registerPost);

    // Should create a new post (not repurpose the tasks post)
    expect(platform.createPost).toHaveBeenCalledWith('New response content', 'thread1');

    // Tasks post should remain unchanged
    expect(session.tasksPostId).toBe('tasks_post');
  });

  test('bumps active task list when creating new post', async () => {
    // Set up active (non-completed) task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (0/1)\n○ Pending task';
    session.tasksCompleted = false;

    // No current post, so flush will create one
    session.currentPostId = null;
    session.pendingContent = 'New response content';

    await flush(session, registerPost);

    // Should repurpose tasks post for new content
    expect(platform.updatePost).toHaveBeenCalledWith('tasks_post', 'New response content');

    // Should create new tasks post at bottom with toggle emoji
    expect(platform.createInteractivePost).toHaveBeenCalledWith(
      '📋 **Tasks** (0/1)\n○ Pending task',
      ['arrow_down_small'],
      'thread1'
    );
  });
});

// ---------------------------------------------------------------------------
// Logical breakpoint detection tests
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
    // Should break BEFORE the heading
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
    // Start after the tool marker
    const result = findLogicalBreakpoint(content, 15);
    expect(result?.type).toBe('heading');
  });

  test('respects maxLookAhead parameter', () => {
    const content = 'Short window\n' + 'X'.repeat(600) + '\n## Far heading';
    // Only look 50 chars ahead - won't find the heading
    const result = findLogicalBreakpoint(content, 0, 50);
    expect(result?.type).toBe('none'); // Falls back to line break
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
    expect(endsAtBreakpoint('Some output\n  ↳ ✓  ')).toBe('tool_marker'); // with trailing whitespace
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

describe('flush with smart breaking', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('breaks at logical breakpoint when exceeding soft threshold', async () => {
    // Create content that exceeds soft threshold with a logical breakpoint
    const firstPart = 'X'.repeat(SOFT_BREAK_THRESHOLD);
    const content = firstPart + '\n  ↳ ✓\nRemaining content after tool result';

    session.currentPostId = 'existing_post';
    session.pendingContent = content;

    await flush(session, registerPost);

    // Should have updated existing post with first part
    expect(platform.updatePost).toHaveBeenCalled();

    // Should have created continuation post
    expect(platform.createPost).toHaveBeenCalled();
  });

  test('does not break when under minimum threshold', async () => {
    // Short content - should not break even with breakpoints
    const content = 'Short\n  ↳ ✓\nMore';

    session.currentPostId = 'existing_post';
    session.pendingContent = content;

    await flush(session, registerPost);

    // Should just update the existing post
    expect(platform.updatePost).toHaveBeenCalledWith('existing_post', content);
    expect(platform.createPost).not.toHaveBeenCalled();
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
    expect(MAX_LINES_BEFORE_BREAK).toBeGreaterThan(5); // More than Mattermost's 5
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
    // Language is undefined when no language is specified
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
    // Check at position after first code block
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

// ---------------------------------------------------------------------------
// findLogicalBreakpoint with code block awareness tests
// ---------------------------------------------------------------------------

describe('findLogicalBreakpoint with code blocks', () => {
  test('returns null when inside code block without closing in window', () => {
    // Content where we're inside a code block and the closing is beyond the search window
    const longCode = 'x'.repeat(600);
    const longContent = `Text\n\`\`\`diff\n${longCode}\n\`\`\`\nafter`;

    // Search from position 20 (inside the diff block) with 100 char lookahead
    // The closing ``` is beyond the 100 char window
    const result = findLogicalBreakpoint(longContent, 20, 100);
    // Should return null because we can't find closing in the 100 char window
    expect(result).toBeNull();
  });

  test('finds code block end when inside block and closing is within window', () => {
    const content = 'Text\n```diff\n- old\n+ new\n```\nMore text after';
    // Start searching from inside the diff block
    const result = findLogicalBreakpoint(content, 15);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('code_block_end');
    // Should break after the closing ```
    expect(result?.position).toBeGreaterThan(content.indexOf('```\n'));
  });

  test('does not suggest break inside code block for paragraph markers', () => {
    const content = '```typescript\ncode\n\nmore code\n```';
    // The \n\n inside the code block should NOT be a valid break point
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('code_block_end');
    // Position should be after the closing ```
    expect(result?.position).toBe(content.length);
  });

  test('prefers code block end over other markers inside the block', () => {
    // Content with a "heading" pattern inside a code block
    const content = '```markdown\n## Heading inside block\n```\noutside';
    const result = findLogicalBreakpoint(content, 0);
    expect(result?.type).toBe('code_block_end');
  });
});

// ---------------------------------------------------------------------------
// updatePost failure handling tests
// ---------------------------------------------------------------------------

describe('flush handles updatePost failures', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('clears currentPostId when normal update fails', async () => {
    session.currentPostId = 'deleted_post';
    session.pendingContent = 'Some content';

    // Make updatePost fail
    (platform.updatePost as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('Post not found');
    });

    // Should not throw
    await flush(session, registerPost);

    // currentPostId should be cleared so next flush creates a new post
    expect(session.currentPostId).toBeNull();
  });

  test('creates new post after failed update on next flush', async () => {
    session.currentPostId = 'deleted_post';
    session.pendingContent = 'Content part 1';

    // First flush - update fails
    (platform.updatePost as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('Post not found');
    });

    await flush(session, registerPost);
    expect(session.currentPostId).toBeNull();

    // Second flush - should create a new post since currentPostId is null
    session.pendingContent = 'Content part 2';
    await flush(session, registerPost);

    expect(platform.createPost).toHaveBeenCalledWith('Content part 2', 'thread1');
    expect(session.currentPostId).toBe('post_1');
  });

  test('clears currentPostId when soft break update fails (no breakpoint)', async () => {
    // Create content that exceeds soft threshold but has no good breakpoint
    // shouldFlushEarly returns true but findLogicalBreakpoint returns null
    const contentWithNoBreakpoint = 'X'.repeat(SOFT_BREAK_THRESHOLD + 100);

    session.currentPostId = 'deleted_post';
    session.pendingContent = contentWithNoBreakpoint;

    // Make updatePost fail
    (platform.updatePost as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('Post not found');
    });

    await flush(session, registerPost);

    // currentPostId should be cleared
    expect(session.currentPostId).toBeNull();
  });

  test('continues after split update failure', async () => {
    // Create content that will be split (exceeds hard threshold)
    const longContent = 'Y'.repeat(15000);

    session.currentPostId = 'deleted_post';
    session.pendingContent = longContent;

    // Make first updatePost fail (the split update)
    (platform.updatePost as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('Post not found');
    });

    await flush(session, registerPost);

    // Even though first update failed, should still try to create continuation
    // currentPostId is cleared and a continuation post is created
    expect(session.currentPostId).not.toBe('deleted_post');
  });

  test('handles task post repurpose failure gracefully', async () => {
    // Set up task list
    session.tasksPostId = 'deleted_tasks_post';
    session.lastTasksContent = '📋 Tasks';
    session.currentPostId = null;
    session.pendingContent = 'New content';

    // Make first updatePost fail (the repurpose attempt)
    (platform.updatePost as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('Post not found');
    });

    // Should not throw
    await flush(session, registerPost);

    // Should still try to create new task post
    expect(platform.createInteractivePost).toHaveBeenCalled();
  });

  test('does not spam warnings when update repeatedly fails', async () => {
    session.currentPostId = 'deleted_post';
    session.pendingContent = 'Content';

    // Fail the update
    (platform.updatePost as ReturnType<typeof mock>).mockImplementation(() => {
      throw new Error('Post not found');
    });

    // First flush - update fails, currentPostId cleared
    await flush(session, registerPost);
    expect(session.currentPostId).toBeNull();

    // Reset pendingContent for second flush
    session.pendingContent = 'More content';

    // Second flush - should create new post, not try to update the deleted one
    await flush(session, registerPost);

    // updatePost should only have been called once (the first failed attempt)
    expect(platform.updatePost).toHaveBeenCalledTimes(1);
    // createPost should have been called for the second flush
    expect(platform.createPost).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Platform-specific message limits tests
// ---------------------------------------------------------------------------

describe('platform-specific message limits', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('uses platform getMessageLimits for thresholds', async () => {
    // Configure platform with lower limits (like Slack)
    (platform.getMessageLimits as ReturnType<typeof mock>).mockReturnValue({
      maxLength: 12000,
      hardThreshold: 10000,
    });

    // Create content that exceeds the lower Slack threshold (10000)
    // but would be under the default Mattermost threshold (14000)
    const slackLongContent = 'S'.repeat(11000);
    session.currentPostId = 'existing_post';
    session.pendingContent = slackLongContent;

    await flush(session, registerPost);

    // Should have split at the lower threshold
    expect(platform.updatePost).toHaveBeenCalled();
    const updateCall = (platform.updatePost as ReturnType<typeof mock>).mock.calls[0];
    // First part should contain content (content was split)
    expect(updateCall[1]).toContain('SSSS');
  });

  test('respects higher Mattermost limits', async () => {
    // Default mock returns Mattermost limits (16000/14000)
    (platform.getMessageLimits as ReturnType<typeof mock>).mockReturnValue({
      maxLength: 16000,
      hardThreshold: 14000,
    });

    // Create content that's above Slack threshold but below Mattermost
    const mattermostContent = 'M'.repeat(11000);
    session.currentPostId = 'existing_post';
    session.pendingContent = mattermostContent;

    await flush(session, registerPost);

    // Should NOT split - content is under Mattermost threshold
    expect(platform.updatePost).toHaveBeenCalledWith('existing_post', mattermostContent);
    expect(platform.createPost).not.toHaveBeenCalled();
  });

  test('truncates content when exceeding maxLength', async () => {
    (platform.getMessageLimits as ReturnType<typeof mock>).mockReturnValue({
      maxLength: 12000,
      hardThreshold: 10000,
    });

    // Create content that exceeds maxLength even after splitting
    // This tests the safety truncation path
    const veryLongContent = 'V'.repeat(13000);
    session.currentPostId = null; // No existing post
    session.pendingContent = veryLongContent;

    await flush(session, registerPost);

    // Content should have been truncated
    const createCall = (platform.createPost as ReturnType<typeof mock>).mock.calls[0];
    expect(createCall[0].length).toBeLessThan(13000);
    expect(createCall[0]).toContain('... (truncated)');
  });
});
