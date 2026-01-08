/**
 * Mattermost client unit tests
 *
 * Tests for Mattermost-specific functionality, particularly emoji handling in messages.
 */

import { describe, it, expect } from 'bun:test';
import { convertUnicodeEmojiToShortcodes } from '../utils.js';

describe('Mattermost Client Emoji Handling', () => {
  describe('convertUnicodeEmojiToShortcodes for messages', () => {
    it('converts Unicode emoji to Mattermost shortcode format', () => {
      expect(convertUnicodeEmojiToShortcodes('🔄 Update available'))
        .toBe(':arrows_counterclockwise: Update available');
    });

    it('converts multiple emoji in a message', () => {
      expect(convertUnicodeEmojiToShortcodes('👍 or 👎'))
        .toBe(':+1: or :-1:');
    });

    it('converts emoji at start, middle, and end of message', () => {
      expect(convertUnicodeEmojiToShortcodes('🎉 Success! ✅'))
        .toBe(':partying_face: Success! :white_check_mark:');
    });

    it('leaves text without emoji unchanged', () => {
      expect(convertUnicodeEmojiToShortcodes('Hello world'))
        .toBe('Hello world');
    });

    it('leaves existing shortcodes unchanged', () => {
      expect(convertUnicodeEmojiToShortcodes(':smile: test'))
        .toBe(':smile: test');
    });
  });

  describe('update notification messages', () => {
    // Test actual messages from auto-update/manager.ts
    it('converts "Update available" message emoji', () => {
      const message = '🔄 **Update available:** v1.0.0';
      expect(convertUnicodeEmojiToShortcodes(message))
        .toBe(':arrows_counterclockwise: **Update available:** v1.0.0');
    });

    it('converts "Installing update" message emoji', () => {
      const message = '📦 **Installing update** v1.0.1...';
      expect(convertUnicodeEmojiToShortcodes(message))
        .toBe(':package: **Installing update** v1.0.1...');
    });

    it('converts "Update installed" message emoji', () => {
      const message = '✅ **Update installed** - restarting now.';
      expect(convertUnicodeEmojiToShortcodes(message))
        .toBe(':white_check_mark: **Update installed** - restarting now.');
    });

    it('converts "Bot updated" message emoji', () => {
      const message = '🎉 **Bot updated** from v1.0.0 to v1.0.1';
      expect(convertUnicodeEmojiToShortcodes(message))
        .toBe(':partying_face: **Bot updated** from v1.0.0 to v1.0.1');
    });

    it('converts "Forcing update" message emoji', () => {
      const message = '🔄 **Forcing update** - restarting shortly...';
      expect(convertUnicodeEmojiToShortcodes(message))
        .toBe(':arrows_counterclockwise: **Forcing update** - restarting shortly...');
    });
  });

  describe('session lifecycle messages', () => {
    it('converts "Session resumed" message emoji', () => {
      const message = '🔄 **Session resumed** by @user';
      expect(convertUnicodeEmojiToShortcodes(message))
        .toBe(':arrows_counterclockwise: **Session resumed** by @user');
    });
  });

  describe('reaction prompt messages', () => {
    it('converts update prompt with reaction hints', () => {
      const message = 'React: 👍 Update now | 👎 Defer for 1 hour';
      expect(convertUnicodeEmojiToShortcodes(message))
        .toBe('React: :+1: Update now | :-1: Defer for 1 hour');
    });

    it('converts permission prompt with reaction hints', () => {
      const message = '👍 Allow | ✅ Allow all | 👎 Deny';
      expect(convertUnicodeEmojiToShortcodes(message))
        .toBe(':+1: Allow | :white_check_mark: Allow all | :-1: Deny');
    });
  });
});
