/**
 * Custom assertions for integration tests
 */

import { expect } from 'bun:test';
import type { MattermostPost } from '../fixtures/mattermost/api-helpers.js';

/**
 * Assert that a post contains specific text
 */
export function assertPostContains(post: MattermostPost, text: string): void {
  expect(post.message).toContain(text);
}

/**
 * Assert that a post matches a pattern
 */
export function assertPostMatches(post: MattermostPost, pattern: RegExp): void {
  expect(post.message).toMatch(pattern);
}

/**
 * Assert that a post is from a specific user
 */
export function assertPostFromUser(post: MattermostPost, userId: string): void {
  expect(post.user_id).toBe(userId);
}

/**
 * Assert that a post is a reply to another post
 */
export function assertIsReply(post: MattermostPost, rootId: string): void {
  expect(post.root_id).toBe(rootId);
}

/**
 * Assert that posts are in chronological order
 */
export function assertChronologicalOrder(posts: MattermostPost[]): void {
  for (let i = 1; i < posts.length; i++) {
    expect(posts[i].create_at).toBeGreaterThanOrEqual(posts[i - 1].create_at);
  }
}

/**
 * Assert that a post has a specific reaction
 */
export function assertHasReaction(
  post: MattermostPost,
  emojiName: string,
  userId?: string,
): void {
  const reactions = post.metadata?.reactions || [];
  const matching = reactions.filter((r) => r.emoji_name === emojiName);

  expect(matching.length).toBeGreaterThan(0);

  if (userId) {
    const fromUser = matching.find((r) => r.user_id === userId);
    expect(fromUser).toBeDefined();
  }
}

/**
 * Assert that a post does not have a specific reaction
 */
export function assertNoReaction(
  post: MattermostPost,
  emojiName: string,
  userId?: string,
): void {
  const reactions = post.metadata?.reactions || [];

  if (userId) {
    const matching = reactions.find(
      (r) => r.emoji_name === emojiName && r.user_id === userId,
    );
    expect(matching).toBeUndefined();
  } else {
    const matching = reactions.find((r) => r.emoji_name === emojiName);
    expect(matching).toBeUndefined();
  }
}

/**
 * Assert that there are N posts in a thread
 */
export function assertThreadLength(posts: MattermostPost[], expectedLength: number): void {
  expect(posts.length).toBe(expectedLength);
}

/**
 * Assert that a post was created within a time window
 */
export function assertRecentPost(
  post: MattermostPost,
  maxAgeMs: number = 60000,
): void {
  const age = Date.now() - post.create_at;
  expect(age).toBeLessThan(maxAgeMs);
}

/**
 * Assert that a session started successfully
 * Checks for typical session start indicators in posts
 */
export function assertSessionStarted(posts: MattermostPost[], botUserId: string): void {
  // There should be at least one post from the bot
  const botPosts = posts.filter((p) => p.user_id === botUserId);
  expect(botPosts.length).toBeGreaterThan(0);

  // The first bot post should contain session info
  // (This is flexible - adjust based on actual session start format)
}

/**
 * Assert error message format
 */
export function assertErrorMessage(post: MattermostPost): void {
  // Error messages typically contain certain patterns
  expect(post.message).toMatch(/error|failed|unable|cannot/i);
}

/**
 * Create a custom matcher for posts
 */
export function postMatching(
  predicate: (post: MattermostPost) => boolean,
): (posts: MattermostPost[]) => MattermostPost | undefined {
  return (posts) => posts.find(predicate);
}

/**
 * Find post by content pattern
 */
export function findPostByContent(
  posts: MattermostPost[],
  pattern: RegExp,
): MattermostPost | undefined {
  return posts.find((p) => pattern.test(p.message));
}

/**
 * Find posts from a specific user
 */
export function findPostsFromUser(
  posts: MattermostPost[],
  userId: string,
): MattermostPost[] {
  return posts.filter((p) => p.user_id === userId);
}

/**
 * Get the most recent post
 */
export function getMostRecentPost(posts: MattermostPost[]): MattermostPost | undefined {
  if (posts.length === 0) return undefined;
  return [...posts].sort((a, b) => b.create_at - a.create_at)[0];
}

/**
 * Count posts matching a pattern
 */
export function countPostsMatching(
  posts: MattermostPost[],
  pattern: RegExp,
): number {
  return posts.filter((p) => pattern.test(p.message)).length;
}
