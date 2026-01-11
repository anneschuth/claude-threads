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
  clearFlushedContent,
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
    subagentUpdateTimer: null,
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

describe('clearFlushedContent', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('clears content when exact match', () => {
    session.pendingContent = 'Hello world';
    clearFlushedContent(session, 'Hello world');
    expect(session.pendingContent).toBe('');
  });

  test('preserves content added after flushed content', () => {
    // Simulate: flushed "A", then "B" was appended during async operation
    session.pendingContent = 'AB';
    clearFlushedContent(session, 'A');
    expect(session.pendingContent).toBe('B');
  });

  test('preserves content with newlines added during async', () => {
    // More realistic: flushed "Message 1", then "Message 2\n\n" was appended
    session.pendingContent = 'Message 1Message 2\n\n';
    clearFlushedContent(session, 'Message 1');
    expect(session.pendingContent).toBe('Message 2\n\n');
  });

  test('clears when pendingContent was replaced entirely', () => {
    // Edge case: pendingContent was completely replaced during async operation
    // We clear it to prevent accumulation - safer than keeping stale content
    session.pendingContent = 'Completely different content';
    clearFlushedContent(session, 'Original content that was flushed');
    expect(session.pendingContent).toBe('');
  });

  test('handles empty flushed content', () => {
    session.pendingContent = 'Some content';
    clearFlushedContent(session, '');
    // Empty string is a prefix of everything, so this clears nothing
    expect(session.pendingContent).toBe('Some content');
  });
});

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

  // Regression test: pendingContent must be cleared after flush to prevent accumulation
  // See: fix/slack-flush-accumulation - without clearing, each flush would re-post
  // all previous content plus new content, causing messages to grow indefinitely
  test('clears pendingContent after successful updatePost', async () => {
    // Simulate a post that already has content (from previous flush)
    session.currentPostId = 'existing_post';
    session.currentPostContent = 'Previous content';
    session.pendingContent = 'New chunk';

    await flush(session, registerPost);

    // pendingContent must be cleared after successful flush
    expect(session.pendingContent).toBe('');
    // currentPostContent should have the combined content
    expect(session.currentPostContent).toBe('Previous contentNew chunk');

    // The update should have combined previous + new content
    expect(platform.updatePost).toHaveBeenLastCalledWith('existing_post', 'Previous contentNew chunk');
  });

  test('clears pendingContent after successful createPost', async () => {
    session.currentPostId = null;
    session.pendingContent = 'New post content';

    await flush(session, registerPost);

    // pendingContent must be cleared after successful flush
    expect(session.pendingContent).toBe('');
    // Verify a post was created
    expect(session.currentPostId).not.toBeNull();
  });

  test('clears pendingContent after successful bumpTasksToBottomWithContent', async () => {
    // Set up active task list (not completed)
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (0/1)\n○ Do something';
    session.tasksCompleted = false;
    session.currentPostId = null;
    session.pendingContent = 'Content to bump with';

    await flush(session, registerPost);

    // pendingContent must be cleared after successful flush
    expect(session.pendingContent).toBe('');
  });

  test('combines content when updating the same post', async () => {
    // When updating an existing post, we combine currentPostContent with new content
    // because updatePost REPLACES content (doesn't append).
    session.currentPostId = null;
    session.pendingContent = 'Message 1';

    await flush(session, registerPost);
    expect(session.pendingContent).toBe('');
    expect(session.currentPostContent).toBe('Message 1');

    // Simulate new content being appended to the same message
    session.pendingContent = 'Message 2';
    await flush(session, registerPost);

    // The updatePost should contain combined content
    expect(platform.updatePost).toHaveBeenLastCalledWith('post_1', 'Message 1Message 2');
    expect(session.pendingContent).toBe('');
    expect(session.currentPostContent).toBe('Message 1Message 2');

    // Third chunk
    session.pendingContent = 'Message 3';
    await flush(session, registerPost);

    // Should contain all combined content
    expect(platform.updatePost).toHaveBeenLastCalledWith('post_1', 'Message 1Message 2Message 3');
    expect(session.pendingContent).toBe('');
    expect(session.currentPostContent).toBe('Message 1Message 2Message 3');
  });

  test('starts fresh post after clearing currentPostId', async () => {
    // This verifies that when we want to start a new message (after result event),
    // clearing currentPostId and currentPostContent makes the next flush create a new post
    session.currentPostId = null;
    session.currentPostContent = '';
    session.pendingContent = 'First message';

    await flush(session, registerPost);
    expect(session.currentPostId).not.toBeNull();
    expect(session.currentPostContent).toBe('First message');

    // Simulate result event clearing state to start fresh
    session.currentPostId = null;
    session.currentPostContent = '';
    session.pendingContent = 'Second message';

    await flush(session, registerPost);

    // Should create a new post (createPost called again), not update the old one
    expect(platform.createPost).toHaveBeenCalledTimes(2);
    expect(session.currentPostContent).toBe('Second message');
  });

  // Regression test: content added during async flush operation must be preserved
  // This simulates the race condition where new events arrive while createPost/updatePost is in flight
  test('preserves content added during async createPost operation', async () => {
    session.currentPostId = null;
    session.pendingContent = 'Initial content';

    // Mock createPost to simulate async delay and content being added during that time
    let resolveCreate: (post: any) => void;
    const createPromise = new Promise<any>((resolve) => {
      resolveCreate = resolve;
    });
    (platform.createPost as any).mockImplementationOnce(async () => {
      // Simulate content being appended while we're awaiting createPost
      session.pendingContent += 'Content added during async\n\n';
      return createPromise;
    });

    // Start the flush (it will await createPost)
    const flushPromise = flush(session, registerPost);

    // Resolve the createPost
    resolveCreate!({
      id: 'async_post',
      platformId: 'test',
      channelId: 'channel1',
      userId: 'bot',
      message: 'Initial content',
      rootId: 'thread1',
      createAt: Date.now(),
    });

    await flushPromise;

    // The content added during async should NOT be lost
    // Only 'Initial content' was flushed, so 'Content added during async\n\n' should remain
    expect(session.pendingContent).toBe('Content added during async\n\n');
  });

  test('preserves content added during async updatePost operation', async () => {
    session.currentPostId = 'existing_post';
    session.pendingContent = 'Update content';

    // Mock updatePost to simulate async delay and content being added during that time
    let resolveUpdate: (post: any) => void;
    const updatePromise = new Promise<any>((resolve) => {
      resolveUpdate = resolve;
    });
    (platform.updatePost as any).mockImplementationOnce(async () => {
      // Simulate content being appended while we're awaiting updatePost
      session.pendingContent += 'New event during update\n\n';
      return updatePromise;
    });

    // Start the flush (it will await updatePost)
    const flushPromise = flush(session, registerPost);

    // Resolve the updatePost
    resolveUpdate!({
      id: 'existing_post',
      platformId: 'test',
      channelId: 'channel1',
      userId: 'bot',
      message: 'Update content',
      rootId: '',
      createAt: Date.now(),
    });

    await flushPromise;

    // The content added during async should NOT be lost
    // Only 'Update content' was flushed, so 'New event during update\n\n' should remain
    expect(session.pendingContent).toBe('New event during update\n\n');
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

  test('handles deletePost 404 gracefully and continues', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 Tasks';

    // Make deletePost reject with a 404 error (post already gone)
    (platform.deletePost as ReturnType<typeof mock>).mockImplementationOnce(() => {
      return Promise.reject(new Error('Mattermost API error 404: post not found'));
    });

    // Should not throw
    await bumpTasksToBottom(session);

    // deletePost was called but failed
    expect(platform.deletePost).toHaveBeenCalledWith('tasks_post');

    // Should still create a new post despite deletePost failure
    expect(platform.createInteractivePost).toHaveBeenCalledWith(
      '📋 Tasks',
      ['arrow_down_small'],
      'thread1'
    );

    // tasksPostId should be updated to the new post
    expect(session.tasksPostId).toBe('post_1');
  });

  test('handles createInteractivePost errors gracefully', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 Tasks';

    // Mock console.error to suppress expected error output
    const originalConsoleError = console.error;
    console.error = mock(() => {});

    // Make createInteractivePost throw an error (after deletePost succeeds)
    (platform.createInteractivePost as ReturnType<typeof mock>).mockImplementationOnce(
      () => {
        throw new Error('Network error');
      }
    );

    // Should not throw
    await bumpTasksToBottom(session);

    // tasksPostId should remain unchanged due to error
    expect(session.tasksPostId).toBe('tasks_post');

    // Verify error was logged
    expect(console.error).toHaveBeenCalled();

    // Restore console.error
    console.error = originalConsoleError;
  });

});

// NOTE: Lock-related tests (acquireTaskListLock, concurrent bumping) have been removed.
// Task list operation ordering is now handled by MessageManager's operation queue.

// NOTE: Message splitting/continuation tests have been moved to
// src/operations/executors/content.test.ts since that logic is now
// handled by ContentExecutor.

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

// NOTE: Smart breaking tests have been moved to
// src/operations/executors/content.test.ts since that logic is now
// handled by ContentExecutor.

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
