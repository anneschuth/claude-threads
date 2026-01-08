/**
 * Slack client unit tests
 *
 * Tests for Slack-specific functionality, particularly emoji handling.
 */

import { describe, it, expect } from 'bun:test';
import { getEmojiName } from '../utils.js';

describe('Slack Client Emoji Handling', () => {
  describe('getEmojiName conversion for reactions', () => {
    it('converts Unicode thumbs up to +1', () => {
      expect(getEmojiName('👍')).toBe('+1');
    });

    it('converts Unicode thumbs down to -1', () => {
      expect(getEmojiName('👎')).toBe('-1');
    });

    it('converts Unicode checkmark to white_check_mark', () => {
      expect(getEmojiName('✅')).toBe('white_check_mark');
    });

    it('converts Unicode X to x', () => {
      expect(getEmojiName('❌')).toBe('x');
    });

    it('passes through already-valid emoji names', () => {
      expect(getEmojiName('+1')).toBe('+1');
      expect(getEmojiName('-1')).toBe('-1');
      expect(getEmojiName('white_check_mark')).toBe('white_check_mark');
      expect(getEmojiName('thumbsup')).toBe('thumbsup');
    });

    it('passes through unknown emoji unchanged', () => {
      expect(getEmojiName('custom_emoji')).toBe('custom_emoji');
      expect(getEmojiName('🦄')).toBe('🦄'); // Not in our mapping
    });
  });

  describe('reaction emoji used in update prompts', () => {
    // These are the actual emoji used in session/manager.ts for update prompts
    const updatePromptEmoji = ['👍', '👎'];

    it('converts all update prompt emoji to valid Slack names', () => {
      const converted = updatePromptEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', '-1']);
    });
  });

  describe('reaction emoji used in permission prompts', () => {
    // These are the actual emoji used in mcp/permission-server.ts
    const permissionPromptEmoji = ['👍', '✅', '👎'];

    it('converts all permission prompt emoji to valid Slack names', () => {
      const converted = permissionPromptEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', 'white_check_mark', '-1']);
    });
  });

  describe('reaction emoji used in message approval', () => {
    // These are the actual emoji used for message approval prompts
    const messageApprovalEmoji = ['👍', '✅', '👎'];

    it('converts all message approval emoji to valid Slack names', () => {
      const converted = messageApprovalEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', 'white_check_mark', '-1']);
    });
  });
});
