/**
 * Shared test harness for executor unit tests. Eight executor test files
 * carried near-identical copies of this formatter/platform/context preamble;
 * the variations are covered by the optional callbacks and the exposed
 * `posts` map.
 *
 * NOTE: this formatter deliberately stubs formatTable/formatKeyValueList to
 * '' (matching the copies it replaces) — executors under test never render
 * tables. Use src/test-utils/mock-formatter.ts where real table output
 * matters.
 */

import { mock } from 'bun:test';
import type { ExecutorContext } from '../operations/executors/types.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../platform/index.js';
import { DefaultContentBreaker } from '../operations/content-breaker.js';
import { PostTracker } from '../operations/post-tracker.js';

export const mockFormatter: PlatformFormatter = {
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

export interface MockExecutorPlatform extends PlatformClient {
  /** Post store for assertions: id → { content, reactions }. */
  posts: Map<string, { content: string; reactions: string[] }>;
}

export function createMockPlatform(): MockExecutorPlatform {
  const posts = new Map<string, { content: string; reactions: string[] }>();
  let postIdCounter = 0;

  return {
    getFormatter: () => mockFormatter,
    createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content, reactions: [] });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    createInteractivePost: mock(async (content: string, reactions: string[], _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content, reactions });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    updatePost: mock(async (postId: string, content: string): Promise<void> => {
      const post = posts.get(postId);
      if (post) {
        post.content = content;
      }
    }),
    deletePost: mock(async (_postId: string): Promise<void> => {}),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
    pinPost: mock(async () => {}),
    unpinPost: mock(async () => {}),
    addReaction: mock(async () => {}),
    removeReaction: mock(async () => {}),
    posts,
  } as unknown as MockExecutorPlatform;
}

export function createTestContext(
  platform?: PlatformClient,
  callbacks?: {
    registerPost?: (postId: string, options: unknown) => void;
    updateLastMessage?: (post: PlatformPost) => void;
  }
): ExecutorContext {
  const p = platform ?? createMockPlatform();
  const threadId = 'thread-123';
  const registerPost = callbacks?.registerPost ?? (() => {});
  const updateLastMessage = callbacks?.updateLastMessage ?? (() => {});

  return {
    sessionId: 'test:session-1',
    threadId,
    platform: p,
    postTracker: new PostTracker(),
    contentBreaker: new DefaultContentBreaker(),
    formatter: mockFormatter,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, debugJson: () => {}, forSession: () => ({} as any) } as any,
    // Helper methods that combine create + register + track
    createPost: async (content, options) => {
      const post = await p.createPost(content, threadId);
      registerPost(post.id, options);
      updateLastMessage(post);
      return post;
    },
    createInteractivePost: async (content, reactions, options) => {
      const post = await p.createInteractivePost(content, reactions, threadId);
      registerPost(post.id, options);
      updateLastMessage(post);
      return post;
    },
  };
}
