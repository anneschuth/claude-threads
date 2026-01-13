/**
 * Tests for ContentExecutor
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ContentExecutor } from './content.js';
import type { ExecutorContext } from './types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../../platform/index.js';
import { PostTracker, type RegisterPostOptions } from '../post-tracker.js';
import { DefaultContentBreaker } from '../content-breaker.js';
import { createAppendContentOp, createFlushOp } from '../types.js';

// Mock formatter
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

// Create mock platform
function createMockPlatform(): PlatformClient {
  const posts = new Map<string, { content: string }>();
  let postIdCounter = 0;

  return {
    getFormatter: () => mockFormatter,
    createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    updatePost: mock(async (postId: string, content: string): Promise<void> => {
      const post = posts.get(postId);
      if (post) {
        post.content = content;
      }
    }),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
  } as unknown as PlatformClient;
}

describe('ContentExecutor', () => {
  let executor: ContentExecutor;
  let platform: PlatformClient;
  let postTracker: PostTracker;
  let contentBreaker: DefaultContentBreaker;
  let registeredPosts: Map<string, RegisterPostOptions | undefined>;
  let lastMessage: PlatformPost | null;

  beforeEach(() => {
    platform = createMockPlatform();
    postTracker = new PostTracker();
    contentBreaker = new DefaultContentBreaker();
    registeredPosts = new Map();
    lastMessage = null;

    executor = new ContentExecutor({
      registerPost: (postId, options) => {
        registeredPosts.set(postId, options ?? { type: 'content' });
      },
      updateLastMessage: (post) => {
        lastMessage = post;
      },
    });
  });

  function getContext(): ExecutorContext {
    const threadId = 'thread-123';
    return {
      sessionId: 'test:session-1',
      threadId,
      platform,
      postTracker,
      contentBreaker,
      formatter: mockFormatter,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
      // Helper methods that combine create + register + track
      createPost: async (content, options) => {
        const post = await platform.createPost(content, threadId);
        registeredPosts.set(post.id, options ?? { type: 'content' });
        lastMessage = post;
        return post;
      },
      createInteractivePost: async (content, reactions, options) => {
        const post = await platform.createInteractivePost(content, reactions, threadId);
        registeredPosts.set(post.id, options);
        lastMessage = post;
        return post;
      },
    };
  }

  describe('Initialization', () => {
    it('creates executor with empty state', () => {
      const state = executor.getState();
      expect(state.currentPostId).toBeNull();
      expect(state.currentPostContent).toBe('');
      expect(state.pendingContent).toBe('');
      expect(state.updateTimer).toBeNull();
    });

    it('resets state correctly', async () => {
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), getContext());
      executor.reset();

      const state = executor.getState();
      expect(state.pendingContent).toBe('');
    });
  });

  describe('Append Content', () => {
    it('appends content to pending', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);

      expect(executor.getState().pendingContent).toBe('Hello');
    });

    it('accumulates multiple appends', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello '), ctx);
      await executor.executeAppend(createAppendContentOp('test', 'World'), ctx);

      expect(executor.getState().pendingContent).toBe('Hello World');
    });
  });

  describe('Flush', () => {
    it('does nothing when no pending content', async () => {
      const ctx = getContext();
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(platform.createPost).not.toHaveBeenCalled();
    });

    it('creates post when flushing content', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello World'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(platform.createPost).toHaveBeenCalledWith('Hello World', 'thread-123');
      expect(executor.getState().currentPostId).toBe('post_1');
      expect(executor.getState().pendingContent).toBe('');
    });

    it('updates existing post when currentPostId is set', async () => {
      const ctx = getContext();

      // First flush creates a post
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // Second flush updates the same post
      // Content is combined with proper spacing between updates
      await executor.executeAppend(createAppendContentOp('test', 'World'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(platform.createPost).toHaveBeenCalledTimes(1);
      expect(platform.updatePost).toHaveBeenCalledTimes(1);
      // Content is combined with separator between updates
      expect(platform.updatePost).toHaveBeenCalledWith('post_1', 'Hello\n\nWorld');
    });

    it('registers post for reaction routing', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(registeredPosts.has('post_1')).toBe(true);
      expect(registeredPosts.get('post_1')?.type).toBe('content');
    });

    it('updates lastMessage after creating post', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(lastMessage).not.toBeNull();
      expect(lastMessage?.id).toBe('post_1');
    });

    it('clears pending content after flush', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(executor.getState().pendingContent).toBe('');
    });

    it('preserves content added during async flush', async () => {
      const ctx = getContext();

      // Simulate content being added during async operation
      let addedDuringFlush = false;
      const originalCreatePost = platform.createPost;
      (platform.createPost as ReturnType<typeof mock>) = mock(async (content: string, threadId: string) => {
        // Add more content during the async createPost call
        if (!addedDuringFlush) {
          addedDuringFlush = true;
          await executor.executeAppend(createAppendContentOp('test', ' extra'), ctx);
        }
        return originalCreatePost(content, threadId);
      });

      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // The extra content should be preserved
      expect(executor.getState().pendingContent).toBe(' extra');
    });

    it('adds separator between tool outputs across multiple flushes', async () => {
      // This tests the scenario where tool_result events trigger flushes
      // between each tool_use operation
      const ctx = getContext();

      // First: text + tool, then flush (simulates tool_result)
      await executor.executeAppend(createAppendContentOp('test', 'Sure! Let me try.'), ctx);
      await executor.executeAppend(createAppendContentOp('test', '📁 Bash `pwd`', true), ctx);
      await executor.executeFlush(createFlushOp('test', 'tool_complete'), ctx);

      // Second: another tool, then flush
      await executor.executeAppend(createAppendContentOp('test', '🔍 Glob `*.ts`', true), ctx);
      await executor.executeFlush(createFlushOp('test', 'tool_complete'), ctx);

      // Third: another tool, then flush
      await executor.executeAppend(createAppendContentOp('test', '📁 Read `file.ts`', true), ctx);
      await executor.executeFlush(createFlushOp('test', 'tool_complete'), ctx);

      // Verify proper spacing was added between each flush
      expect(platform.createPost).toHaveBeenCalledTimes(1);
      expect(platform.updatePost).toHaveBeenCalledTimes(2);

      // Check the final combined content has proper separators
      const finalContent = executor.getState().currentPostContent;
      expect(finalContent).toContain('Sure! Let me try.');
      expect(finalContent).toContain('\n\n📁 Bash');
      expect(finalContent).toContain('\n\n🔍 Glob');
      expect(finalContent).toContain('\n\n📁 Read');
    });
  });

  describe('Schedule Flush', () => {
    it('schedules delayed flush', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      executor.scheduleFlush(ctx, 10);

      expect(executor.getState().updateTimer).not.toBeNull();

      // Wait for timer
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(executor.getState().updateTimer).toBeNull();
      expect(platform.createPost).toHaveBeenCalled();
    });

    it('does not double-schedule', async () => {
      const ctx = getContext();
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);

      executor.scheduleFlush(ctx, 100);
      const timer1 = executor.getState().updateTimer;

      executor.scheduleFlush(ctx, 100);
      const timer2 = executor.getState().updateTimer;

      // Same timer reference
      expect(timer1).toBe(timer2);

      // Cleanup
      executor.reset();
    });
  });

  describe('Task List Bump Integration', () => {
    it('uses bumped post ID when onBumpTaskList returns one', async () => {
      const executorWithBump = new ContentExecutor({
        registerPost: (postId, options) => {
          registeredPosts.set(postId, options ?? { type: 'content' });
        },
        updateLastMessage: (post) => {
          lastMessage = post;
        },
        onBumpTaskList: async (_content, _ctx) => 'bumped_task_post_id',
      });

      const ctx = getContext();
      await executorWithBump.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executorWithBump.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(executorWithBump.getState().currentPostId).toBe('bumped_task_post_id');
      // createPost should not be called since we reused the task list post
      expect(platform.createPost).not.toHaveBeenCalled();
    });

    it('creates new post when onBumpTaskList returns null', async () => {
      const executorWithBump = new ContentExecutor({
        registerPost: (postId, options) => {
          registeredPosts.set(postId, options ?? { type: 'content' });
        },
        updateLastMessage: (post) => {
          lastMessage = post;
        },
        onBumpTaskList: async (_content, _ctx) => null,
      });

      const ctx = getContext();
      await executorWithBump.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executorWithBump.executeFlush(createFlushOp('test', 'explicit'), ctx);

      expect(platform.createPost).toHaveBeenCalled();
    });

    it('passes content and ctx to onBumpTaskList callback', async () => {
      // This test ensures the callback receives the content so it can
      // update the old task list post with the new content
      let receivedContent = '';
      let receivedCtx: unknown = null;

      const executorWithBump = new ContentExecutor({
        registerPost: (postId, options) => {
          registeredPosts.set(postId, options ?? { type: 'content' });
        },
        updateLastMessage: (post) => {
          lastMessage = post;
        },
        onBumpTaskList: async (content, ctx) => {
          receivedContent = content;
          receivedCtx = ctx;
          return 'repurposed_post_id';
        },
      });

      const ctx = getContext();
      await executorWithBump.executeAppend(createAppendContentOp('test', 'Test content'), ctx);
      await executorWithBump.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // Verify the callback received the formatted content
      expect(receivedContent).toBe('Test content');
      // Verify the callback received the executor context
      expect(receivedCtx).toBe(ctx);
    });

    it('bumps task list to bottom after creating new content post (RED-GREEN regression test)', async () => {
      // BUG: When onBumpTaskList returns null (no task post to repurpose),
      // content creates a new post but the task list stays at its old position above the content.
      // FIX: After creating a new content post, call onBumpTaskListToBottom to keep task list at bottom.
      let bumpToBottomCalled = false;

      const executorWithBump = new ContentExecutor({
        registerPost: (postId, options) => {
          registeredPosts.set(postId, options ?? { type: 'content' });
        },
        updateLastMessage: (post) => {
          lastMessage = post;
        },
        onBumpTaskList: async (_content, _ctx) => null, // No task post to repurpose
        onBumpTaskListToBottom: async () => {
          bumpToBottomCalled = true;
        },
      });

      const ctx = getContext();
      await executorWithBump.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executorWithBump.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // Content post should be created
      expect(platform.createPost).toHaveBeenCalled();
      // Task list should be bumped to bottom AFTER content post was created
      expect(bumpToBottomCalled).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('handles updatePost failure gracefully', async () => {
      const ctx = getContext();

      // First flush creates a post
      await executor.executeAppend(createAppendContentOp('test', 'Hello'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // Make updatePost fail
      (platform.updatePost as ReturnType<typeof mock>) = mock(async () => {
        throw new Error('Update failed');
      });

      // Second flush should handle the error
      await executor.executeAppend(createAppendContentOp('test', ' World'), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // currentPostId should be cleared after failure
      expect(executor.getState().currentPostId).toBeNull();
    });
  });

  describe('Content Loss Prevention (RED-GREEN regression test)', () => {
    it('should split content when combined length would exceed platform limit', async () => {
      // BUG: When currentPostContent + pendingContent exceeds MAX_POST_LENGTH,
      // updatePost fails with msg_too_long. The error handler resets currentPostId
      // and clears currentPostContent - losing all the content in currentPostContent!
      //
      // Scenario:
      // 1. First flush: creates post with 10000 chars (under 12000 threshold)
      // 2. Second flush: new content is 8000 chars (under 12000 threshold)
      // 3. Combined would be 18000 chars (over 16000 MAX_POST_LENGTH)
      // 4. updatePost fails with msg_too_long
      // 5. ERROR HANDLER RESETS currentPostContent - CONTENT LOST!
      //
      // FIX: Check combinedContent length BEFORE calling updatePost and split if needed

      // Use lower limits to make test easier
      const testPlatform = {
        ...platform,
        getMessageLimits: () => ({ maxLength: 1000, hardThreshold: 800 }),
        createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
          return {
            id: `post_${Date.now()}`,
            platformId: 'test',
            channelId: 'channel-1',
            message: content,
            createAt: Date.now(),
            userId: 'bot'
          };
        }),
        updatePost: mock(async (_postId: string, content: string): Promise<void> => {
          // Simulate Slack's msg_too_long error when content exceeds limit
          if (content.length > 1000) {
            throw new Error('msg_too_long');
          }
        }),
      } as unknown as PlatformClient;

      const testCtx: ExecutorContext = {
        sessionId: 'test:session-1',
        threadId: 'thread-123',
        platform: testPlatform,
        postTracker,
        contentBreaker,
        formatter: mockFormatter,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
        createPost: async (content, options) => {
          const post = await testPlatform.createPost(content, 'thread-123');
          registeredPosts.set(post.id, options ?? { type: 'content' });
          lastMessage = post;
          return post;
        },
        createInteractivePost: async (content, reactions, options) => {
          const post = await testPlatform.createInteractivePost(content, reactions, 'thread-123');
          registeredPosts.set(post.id, options);
          lastMessage = post;
          return post;
        },
      };

      // First flush: 600 chars (under 800 threshold)
      const content1 = 'A'.repeat(600);
      await executor.executeAppend(createAppendContentOp('test', content1), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      expect(executor.getState().currentPostId).not.toBeNull();
      expect(executor.getState().currentPostContent.length).toBe(600);

      // Second flush: 600 chars (under 800 threshold individually)
      // Combined would be ~1200 chars (over 1000 MAX_POST_LENGTH)
      const content2 = 'B'.repeat(600);
      await executor.executeAppend(createAppendContentOp('test', content2), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // The fix should:
      // 1. Detect that combinedContent would exceed MAX_POST_LENGTH
      // 2. Split into continuation post BEFORE trying updatePost
      // 3. Keep the first 600 chars (content1) in the original post
      // 4. Create a new post for content2
      // Content should NOT be lost - we should have at least 2 posts total
      expect(testPlatform.createPost).toHaveBeenCalledTimes(2); // Original + continuation

      // The currentPostContent should contain the second batch (the continuation post)
      expect(executor.getState().currentPostContent).toContain('B');
      expect(executor.getState().currentPostContent.length).toBeGreaterThan(0);
    });
  });

  describe('Content Loss During Split Prevention (RED-GREEN regression test)', () => {
    it('should preserve new content that arrives during async split operation', async () => {
      // BUG: In handleSplit, line 371 sets `this.state.pendingContent = remainder;`
      // This OVERWRITES any new content that arrived during the async updatePost call.
      //
      // The bug scenario:
      // 1. pendingContent = "ABCDEF" (long content that needs split)
      // 2. Split: firstPart = "ABC", remainder = "DEF"
      // 3. During async updatePost("ABC"), new content "XYZ" is appended
      //    pendingContent = "ABCDEFXYZ"
      // 4. Bug: pendingContent = remainder → pendingContent = "DEF"
      //    NEW CONTENT "XYZ" IS LOST!
      // 5. createNewPost creates post with "DEF"
      // 6. clearFlushedContent clears, but XYZ is already gone

      const NEW_CONTENT_MARKER = 'NEW_CONTENT_ARRIVED_DURING_ASYNC';
      const postedContents: { postId: string; content: string; operation: string }[] = [];
      let appendedDuringAsync = false;

      // Custom executor that we can access to append during async
      const testExecutor = new ContentExecutor({
        registerPost: (postId, options) => {
          registeredPosts.set(postId, options ?? { type: 'content' });
        },
        updateLastMessage: (post) => {
          lastMessage = post;
        },
      });

      const testPlatform = {
        ...platform,
        // Use low threshold to trigger split easily
        getMessageLimits: () => ({ maxLength: 100, hardThreshold: 50 }),
        createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
          const id = `post_${Date.now()}_${Math.random()}`;
          postedContents.push({ postId: id, content, operation: 'create' });
          return {
            id,
            platformId: 'test',
            channelId: 'channel-1',
            message: content,
            createAt: Date.now(),
            userId: 'bot'
          };
        }),
        updatePost: mock(async (postId: string, content: string): Promise<void> => {
          postedContents.push({ postId, content, operation: 'update' });

          // Simulate new content arriving during this async operation
          // This is what happens when the user types while we're updating
          if (!appendedDuringAsync) {
            appendedDuringAsync = true;
            await testExecutor.executeAppend(
              createAppendContentOp('test', NEW_CONTENT_MARKER),
              testCtx
            );
          }
        }),
      } as unknown as PlatformClient;

      const testCtx: ExecutorContext = {
        sessionId: 'test:session-1',
        threadId: 'thread-123',
        platform: testPlatform,
        postTracker,
        contentBreaker,
        formatter: mockFormatter,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
        createPost: async (content, options) => {
          const post = await testPlatform.createPost(content, 'thread-123');
          registeredPosts.set(post.id, options ?? { type: 'content' });
          lastMessage = post;
          return post;
        },
        createInteractivePost: async (content, reactions, options) => {
          const post = await testPlatform.createInteractivePost(content, reactions, 'thread-123');
          registeredPosts.set(post.id, options);
          lastMessage = post;
          return post;
        },
      };

      // First, create a post so we have a currentPostId
      await testExecutor.executeAppend(createAppendContentOp('test', 'Initial content'), testCtx);
      await testExecutor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // Now append content that exceeds hardThreshold (50) to trigger split
      // This needs to be long enough to exceed 50 chars when combined with currentPostContent
      const longContent = 'A'.repeat(60);  // 60 chars, will exceed threshold
      await testExecutor.executeAppend(createAppendContentOp('test', longContent), testCtx);

      // Flush - this should trigger handleSplit, and during the async updatePost,
      // NEW_CONTENT_MARKER will be appended
      await testExecutor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // After the flush, append more content and flush again
      await testExecutor.executeAppend(createAppendContentOp('test', 'Final content'), testCtx);
      await testExecutor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // Verify that NEW_CONTENT_MARKER was NOT lost
      // The marker may be split across posts, so join without separator and check
      const allContent = postedContents.map(p => p.content).join('');
      expect(allContent).toContain(NEW_CONTENT_MARKER);
    });
  });

  describe('Code Block Path State Management (RED-GREEN regression test)', () => {
    it('should update state after code_block_at_start path to prevent stale content', async () => {
      // BUG: The code_block_at_start path in handleSplit updated the post but didn't
      // update currentPostContent or clear pendingContent. This means:
      // 1. Large content X triggers handleSplit -> code_block_at_start
      // 2. Post updated with X, but currentPostContent still has old value, pendingContent not cleared
      // 3. On subsequent flushes, pendingContent still contains X (not cleared!)
      // 4. Verify: after code_block_at_start, pendingContent should be empty

      const UNIQUE_MARKER = 'CODEBLOCK_MARKER_XYZ';

      const testPlatform = {
        ...platform,
        // Low hardThreshold so code block content triggers hard break path
        getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 100 }),
        createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
          const id = `post_${Date.now()}`;
          return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
        }),
        updatePost: mock(async (_postId: string, _content: string): Promise<void> => {}),
      } as unknown as PlatformClient;

      // Custom content breaker that triggers code_block_at_start path
      const codeBlockBreaker = {
        ...contentBreaker,
        findLogicalBreakpoint: () => null, // No breakpoint found -> triggers getCodeBlockState
        getCodeBlockState: () => ({ isInside: true, openPosition: 0 }), // Code block at position 0
        shouldFlushEarly: () => false, // Don't trigger via shouldFlushEarly
        endsAtBreakpoint: () => 'none' as const,
      };

      const testCtx: ExecutorContext = {
        sessionId: 'test:session-1',
        threadId: 'thread-123',
        platform: testPlatform,
        postTracker,
        contentBreaker: codeBlockBreaker,
        formatter: mockFormatter,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
        createPost: async (content, options) => {
          const post = await testPlatform.createPost(content, 'thread-123');
          registeredPosts.set(post.id, options ?? { type: 'content' });
          lastMessage = post;
          return post;
        },
        createInteractivePost: async (content, reactions, options) => {
          const post = await testPlatform.createInteractivePost(content, reactions, 'thread-123');
          registeredPosts.set(post.id, options);
          lastMessage = post;
          return post;
        },
      };

      // Create initial post so we have a currentPostId
      await executor.executeAppend(createAppendContentOp('test', 'Init'), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // Append code block content that exceeds hardThreshold (100)
      // This should trigger handleSplit -> hard break path -> code_block_at_start
      const codeBlockContent = '```\n' + UNIQUE_MARKER + '\n' + 'X'.repeat(150) + '\n```';
      await executor.executeAppend(createAppendContentOp('test', codeBlockContent), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // After flush, pendingContent should be empty (cleared)
      // If the fix is not in place, pendingContent will still contain the code block content
      expect(executor.getState().pendingContent).toBe('');

      // And currentPostContent should match what was posted
      expect(executor.getState().currentPostContent).toContain(UNIQUE_MARKER);
    });

    it('should update state after no_break_before_code_block path to prevent stale content', async () => {
      // BUG: The no_break_before_code_block path in handleSplit updated the post but didn't
      // update currentPostContent or clear pendingContent.
      // This path triggers when: codeBlockOpenPosition > 0 but lastIndexOf('\n') <= 0

      const UNIQUE_MARKER = 'NO_BREAK_MARKER_ABC';

      const testPlatform = {
        ...platform,
        getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 100 }),
        createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
          const id = `post_${Date.now()}`;
          return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
        }),
        updatePost: mock(async (_postId: string, _content: string): Promise<void> => {}),
      } as unknown as PlatformClient;

      // Custom content breaker that triggers no_break_before_code_block path:
      // - codeBlockOpenPosition > 0 (code block not at start)
      // - but content.lastIndexOf('\n', codeBlockOpenPosition) <= 0 (no newline before code block)
      const codeBlockBreaker = {
        ...contentBreaker,
        findLogicalBreakpoint: () => null, // No breakpoint found
        getCodeBlockState: () => ({ isInside: true, openPosition: 5 }), // Code block at position 5 (not 0)
        shouldFlushEarly: () => false,
        endsAtBreakpoint: () => 'none' as const,
      };

      const testCtx: ExecutorContext = {
        sessionId: 'test:session-1',
        threadId: 'thread-123',
        platform: testPlatform,
        postTracker,
        contentBreaker: codeBlockBreaker,
        formatter: mockFormatter,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
        createPost: async (content, options) => {
          const post = await testPlatform.createPost(content, 'thread-123');
          registeredPosts.set(post.id, options ?? { type: 'content' });
          lastMessage = post;
          return post;
        },
        createInteractivePost: async (content, reactions, options) => {
          const post = await testPlatform.createInteractivePost(content, reactions, 'thread-123');
          registeredPosts.set(post.id, options);
          lastMessage = post;
          return post;
        },
      };

      // Create initial post
      await executor.executeAppend(createAppendContentOp('test', 'Init'), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // Content that exceeds hardThreshold and has NO newlines (so lastIndexOf returns -1)
      // This triggers no_break_before_code_block path
      const noNewlineContent = UNIQUE_MARKER + 'X'.repeat(150);
      await executor.executeAppend(createAppendContentOp('test', noNewlineContent), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // After flush, pendingContent should be empty (cleared)
      expect(executor.getState().pendingContent).toBe('');

      // And currentPostContent should match what was posted
      expect(executor.getState().currentPostContent).toContain(UNIQUE_MARKER);
    });
  });

  describe('Content Loss in handleSplit (RED-GREEN regression test)', () => {
    it('should preserve existing post content when handleSplit triggers', async () => {
      // BUG: handleSplit receives `content` which is just pendingContent, not combined with
      // currentPostContent. When updating with firstPart, we lose what was already in the post.
      //
      // Scenario:
      // 1. Post created with "I'll work on these tasks..." (100 chars) - currentPostContent set
      // 2. Large content "Task 1: Counting..." (5000 chars) appended - pendingContent set
      // 3. Flush triggers handleSplit because content (5000) > threshold
      // 4. BUG: handleSplit gets content=pendingContent only, not currentPostContent+pendingContent
      // 5. firstPart = pendingContent.substring(0, breakPoint) - just the new content
      // 6. updatePost(postId, firstPart) - REPLACES post, losing original 100 chars!

      const INITIAL_MARKER = 'INITIAL_CONTENT_MARKER';
      const TASK_MARKER = 'TASK_CONTENT_MARKER';
      const postedContents: { postId: string; content: string; operation: string }[] = [];

      const testPlatform = {
        ...platform,
        // Low threshold to trigger handleSplit
        getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 500 }),
        createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
          const id = `post_${Date.now()}`;
          postedContents.push({ postId: id, content, operation: 'create' });
          return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
        }),
        updatePost: mock(async (postId: string, content: string): Promise<void> => {
          postedContents.push({ postId, content, operation: 'update' });
        }),
      } as unknown as PlatformClient;

      const testCtx: ExecutorContext = {
        sessionId: 'test:session-1',
        threadId: 'thread-123',
        platform: testPlatform,
        postTracker,
        contentBreaker,  // Use real content breaker
        formatter: mockFormatter,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
        createPost: async (content, options) => {
          const post = await testPlatform.createPost(content, 'thread-123');
          registeredPosts.set(post.id, options ?? { type: 'content' });
          lastMessage = post;
          return post;
        },
        createInteractivePost: async (content, reactions, options) => {
          const post = await testPlatform.createInteractivePost(content, reactions, 'thread-123');
          registeredPosts.set(post.id, options);
          lastMessage = post;
          return post;
        },
      };

      // Step 1: Create initial post with marker
      const initialContent = `${INITIAL_MARKER} - I'll work through these tasks one by one.`;
      await executor.executeAppend(createAppendContentOp('test', initialContent), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // Verify initial post was created
      expect(postedContents.length).toBe(1);
      expect(postedContents[0].content).toContain(INITIAL_MARKER);

      // Step 2: Append large content that will trigger handleSplit (> 500 chars threshold)
      const largeContent = `\n\n${TASK_MARKER} - Task 1: ` + 'X'.repeat(600);
      await executor.executeAppend(createAppendContentOp('test', largeContent), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // The first post should still contain INITIAL_MARKER after the update
      // Find all updates to the first post
      const firstPostId = postedContents[0].postId;
      const updatesToFirstPost = postedContents.filter(p => p.postId === firstPostId && p.operation === 'update');

      // If there were updates, the last one should still have the initial marker
      if (updatesToFirstPost.length > 0) {
        const lastUpdate = updatesToFirstPost[updatesToFirstPost.length - 1];
        expect(lastUpdate.content).toContain(INITIAL_MARKER);
      }

      // Also verify TASK_MARKER appears somewhere (either in update or new post)
      const allContent = postedContents.map(p => p.content).join('|||');
      expect(allContent).toContain(TASK_MARKER);
    });
  });

  describe('Content Duplication Prevention (RED-GREEN regression test)', () => {
    it('should not have repeated content within a single post/update', async () => {
      // BUG: When handleSplit was modified to combine currentPostContent + firstPart,
      // it caused duplication where the SAME content appeared TWICE in a SINGLE post.
      // Example: "Task 4: Weather\nTask 4: Weather" (same text repeated)
      //
      // This is different from content appearing in multiple posts during updates,
      // which is CORRECT behavior for incremental updates.
      //
      // The bug occurred when:
      // 1. pendingContent contained content that was already flushed (clearFlushedContent failed)
      // 2. handleSplit combined currentPostContent + firstPart
      // 3. Both contained overlapping content, causing duplication

      // Track what content is actually posted
      const postedContents: { postId: string; content: string; operation: string }[] = [];

      const testPlatform = {
        ...platform,
        getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
        createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
          const id = `post_${Date.now()}_${Math.random()}`;
          postedContents.push({ postId: id, content, operation: 'create' });
          return {
            id,
            platformId: 'test',
            channelId: 'channel-1',
            message: content,
            createAt: Date.now(),
            userId: 'bot'
          };
        }),
        updatePost: mock(async (postId: string, content: string): Promise<void> => {
          postedContents.push({ postId, content, operation: 'update' });
        }),
      } as unknown as PlatformClient;

      const testCtx: ExecutorContext = {
        sessionId: 'test:session-1',
        threadId: 'thread-123',
        platform: testPlatform,
        postTracker,
        contentBreaker,
        formatter: mockFormatter,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
        createPost: async (content, options) => {
          const post = await testPlatform.createPost(content, 'thread-123');
          registeredPosts.set(post.id, options ?? { type: 'content' });
          lastMessage = post;
          return post;
        },
        createInteractivePost: async (content, reactions, options) => {
          const post = await testPlatform.createInteractivePost(content, reactions, 'thread-123');
          registeredPosts.set(post.id, options);
          lastMessage = post;
          return post;
        },
      };

      // Unique markers to track duplication
      const marker1 = 'UNIQUE_MARKER_ABC123';
      const marker2 = 'UNIQUE_MARKER_XYZ789';

      // First flush: content with unique marker
      await executor.executeAppend(createAppendContentOp('test', `Start ${marker1} End`), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // Second flush: different content with different marker
      await executor.executeAppend(createAppendContentOp('test', `Start ${marker2} End`), testCtx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), testCtx);

      // Verify no single posted content contains the same marker twice
      // (which would indicate duplication bug)
      for (const posted of postedContents) {
        const marker1Count = (posted.content.match(new RegExp(marker1, 'g')) || []).length;
        const marker2Count = (posted.content.match(new RegExp(marker2, 'g')) || []).length;

        // Each marker should appear at most once in any single post/update
        expect(marker1Count).toBeLessThanOrEqual(1);
        expect(marker2Count).toBeLessThanOrEqual(1);
      }

      // The combined update should have both markers (once each)
      const lastUpdate = postedContents.filter(p => p.operation === 'update').pop();
      if (lastUpdate) {
        expect(lastUpdate.content).toContain(marker1);
        expect(lastUpdate.content).toContain(marker2);
      }
    });
  });

  describe('Height-based splitting during streaming', () => {
    it('splits when combined content (existing + new) exceeds height threshold', async () => {
      // This test verifies that shouldFlushEarly checks COMBINED content, not just NEW content
      // Bug: If existing post has 400px content and new content adds 300px, total is 700px
      // which should trigger a split, but checking only new content (300px) would not.
      const ctx = getContext();

      // Verify contentBreaker works in this context
      const { estimateRenderedHeight } = await import('../content-breaker.js');
      const testHeight = estimateRenderedHeight('## Test\nSome text');
      expect(testHeight).toBeGreaterThan(0);

      // Create content that's ~350px when rendered (below 500px threshold)
      // About 15 text lines at 21px each = ~315px
      const existingContent = [
        '## Part 1: Introduction',
        'This is the introduction section with some text.',
        'It contains multiple lines of content.',
        '',
        '## Part 2: Details',
        'Here are the details of the implementation.',
        'We need enough content to be significant.',
        '',
        '## Part 3: More Content',
        'Adding more sections to build up height.',
        'Each section contributes to the total.',
        '',
        '## Part 4: Additional Info',
        'This section adds more height to the post.',
        'We are getting closer to the threshold.',
      ].join('\n');

      // New content that's also ~300px (below threshold individually)
      const newContent = [
        '',
        '## Part 5: New Section',
        'This is new content being added.',
        'It has several lines of text.',
        '',
        '## Part 6: Final Section',
        'The final section of content.',
        'With multiple lines as well.',
        'And some extra text here.',
        '',
        '## Part 7: Conclusion',
        'Wrapping up with final thoughts.',
        'This completes the document.',
      ].join('\n');

      // First flush: create post with existing content
      await executor.executeAppend(createAppendContentOp('test', existingContent), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      const stateAfterFirst = executor.getState();
      expect(stateAfterFirst.currentPostId).toBe('post_1');

      // Reset mock counts to track what happens next
      (platform.createPost as ReturnType<typeof mock>).mockClear();
      (platform.updatePost as ReturnType<typeof mock>).mockClear();

      // Second flush: add new content
      // Combined height should be ~650px which exceeds 500px threshold
      // This should trigger handleSplit, creating a continuation post

      // Verify heights before flush - each individually under threshold, combined over
      const existingHeight = estimateRenderedHeight(existingContent);
      const newHeight = estimateRenderedHeight(newContent);
      const combinedHeight = estimateRenderedHeight(existingContent + '\n\n' + newContent);
      expect(existingHeight).toBeLessThan(500);
      expect(newHeight).toBeLessThan(500);
      expect(combinedHeight).toBeGreaterThan(500);

      await executor.executeAppend(createAppendContentOp('test', newContent), ctx);
      await executor.executeFlush(createFlushOp('test', 'explicit'), ctx);

      // BUG: If only checking new content height, no split occurs and updatePost is called
      // FIX: If checking combined content height, split occurs and createPost is called
      const createCalls = (platform.createPost as ReturnType<typeof mock>).mock.calls.length;

      // If split happened correctly, createPost should have been called for continuation
      // If bug exists, only updatePost would be called
      expect(createCalls).toBeGreaterThan(0);
    });
  });
});
