import { describe, it, expect } from 'bun:test';
import {
  isApprovalEmoji,
  isDenialEmoji,
  isAllowAllEmoji,
  isCancelEmoji,
  isEscapeEmoji,
  isResumeEmoji,
  isBugReportEmoji,
  getNumberEmojiIndex,
  APPROVAL_EMOJIS,
  DENIAL_EMOJIS,
  ALLOW_ALL_EMOJIS,
  NUMBER_EMOJIS,
  CANCEL_EMOJIS,
  ESCAPE_EMOJIS,
  RESUME_EMOJIS,
} from './emoji.js';

describe('emoji helpers', () => {
  describe('isApprovalEmoji', () => {
    it('returns true for +1', () => {
      expect(isApprovalEmoji('+1')).toBe(true);
    });

    it('returns true for thumbsup', () => {
      expect(isApprovalEmoji('thumbsup')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isApprovalEmoji('heart')).toBe(false);
      expect(isApprovalEmoji('-1')).toBe(false);
      expect(isApprovalEmoji('x')).toBe(false);
    });

    it('matches all APPROVAL_EMOJIS', () => {
      for (const emoji of APPROVAL_EMOJIS) {
        expect(isApprovalEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isDenialEmoji', () => {
    it('returns true for -1', () => {
      expect(isDenialEmoji('-1')).toBe(true);
    });

    it('returns true for thumbsdown', () => {
      expect(isDenialEmoji('thumbsdown')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isDenialEmoji('heart')).toBe(false);
      expect(isDenialEmoji('+1')).toBe(false);
      expect(isDenialEmoji('thumbsup')).toBe(false);
    });

    it('matches all DENIAL_EMOJIS', () => {
      for (const emoji of DENIAL_EMOJIS) {
        expect(isDenialEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isAllowAllEmoji', () => {
    it('returns true for white_check_mark', () => {
      expect(isAllowAllEmoji('white_check_mark')).toBe(true);
    });

    it('returns true for heavy_check_mark', () => {
      expect(isAllowAllEmoji('heavy_check_mark')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isAllowAllEmoji('heart')).toBe(false);
      expect(isAllowAllEmoji('+1')).toBe(false);
      expect(isAllowAllEmoji('thumbsup')).toBe(false);
    });

    it('matches all ALLOW_ALL_EMOJIS', () => {
      for (const emoji of ALLOW_ALL_EMOJIS) {
        expect(isAllowAllEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isCancelEmoji', () => {
    it('returns true for x', () => {
      expect(isCancelEmoji('x')).toBe(true);
    });

    it('returns true for octagonal_sign', () => {
      expect(isCancelEmoji('octagonal_sign')).toBe(true);
    });

    it('returns true for stop_sign', () => {
      expect(isCancelEmoji('stop_sign')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isCancelEmoji('heart')).toBe(false);
      expect(isCancelEmoji('-1')).toBe(false);
    });

    it('matches all CANCEL_EMOJIS', () => {
      for (const emoji of CANCEL_EMOJIS) {
        expect(isCancelEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isEscapeEmoji', () => {
    it('returns true for double_vertical_bar', () => {
      expect(isEscapeEmoji('double_vertical_bar')).toBe(true);
    });

    it('returns true for pause_button', () => {
      expect(isEscapeEmoji('pause_button')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isEscapeEmoji('heart')).toBe(false);
      expect(isEscapeEmoji('x')).toBe(false);
    });

    it('matches all ESCAPE_EMOJIS', () => {
      for (const emoji of ESCAPE_EMOJIS) {
        expect(isEscapeEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isResumeEmoji', () => {
    it('returns true for arrows_counterclockwise', () => {
      expect(isResumeEmoji('arrows_counterclockwise')).toBe(true);
    });

    it('returns true for arrow_forward', () => {
      expect(isResumeEmoji('arrow_forward')).toBe(true);
    });

    it('returns true for repeat', () => {
      expect(isResumeEmoji('repeat')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isResumeEmoji('heart')).toBe(false);
      expect(isResumeEmoji('x')).toBe(false);
      expect(isResumeEmoji('+1')).toBe(false);
    });

    it('matches all RESUME_EMOJIS', () => {
      for (const emoji of RESUME_EMOJIS) {
        expect(isResumeEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('getNumberEmojiIndex', () => {
    it('returns 0 for "one"', () => {
      expect(getNumberEmojiIndex('one')).toBe(0);
    });

    it('returns 1 for "two"', () => {
      expect(getNumberEmojiIndex('two')).toBe(1);
    });

    it('returns 2 for "three"', () => {
      expect(getNumberEmojiIndex('three')).toBe(2);
    });

    it('returns 3 for "four"', () => {
      expect(getNumberEmojiIndex('four')).toBe(3);
    });

    it('returns 0 for "1️⃣" (unicode)', () => {
      expect(getNumberEmojiIndex('1️⃣')).toBe(0);
    });

    it('returns 1 for "2️⃣" (unicode)', () => {
      expect(getNumberEmojiIndex('2️⃣')).toBe(1);
    });

    it('returns 2 for "3️⃣" (unicode)', () => {
      expect(getNumberEmojiIndex('3️⃣')).toBe(2);
    });

    it('returns 3 for "4️⃣" (unicode)', () => {
      expect(getNumberEmojiIndex('4️⃣')).toBe(3);
    });

    it('returns -1 for non-number emojis', () => {
      expect(getNumberEmojiIndex('heart')).toBe(-1);
      expect(getNumberEmojiIndex('five')).toBe(-1);
      expect(getNumberEmojiIndex('+1')).toBe(-1);
    });

    it('returns correct index for all NUMBER_EMOJIS', () => {
      for (let i = 0; i < NUMBER_EMOJIS.length; i++) {
        expect(getNumberEmojiIndex(NUMBER_EMOJIS[i])).toBe(i);
      }
    });
  });

  describe('isBugReportEmoji', () => {
    it('returns true for "bug" emoji name', () => {
      expect(isBugReportEmoji('bug')).toBe(true);
    });

    it('returns true for 🐛 unicode emoji', () => {
      expect(isBugReportEmoji('🐛')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isBugReportEmoji('+1')).toBe(false);
      expect(isBugReportEmoji('heart')).toBe(false);
      expect(isBugReportEmoji('x')).toBe(false);
    });
  });
});

describe('skin-tone variants (#622 review)', () => {
  // Slack names a 👍 picked with a skin tone `+1::skin-tone-3`. An exact match
  // missed it, and the permission prompt treats every other emoji as deny.
  it('match their base emoji', () => {
    expect(isApprovalEmoji('+1::skin-tone-3')).toBe(true);
    expect(isApprovalEmoji('thumbsup::skin-tone-6')).toBe(true);
    expect(isDenialEmoji('-1::skin-tone-2')).toBe(true);
    expect(isAllowAllEmoji('white_check_mark')).toBe(true);
  });
});

describe('Mattermost skin-tone variants (#629)', () => {
  // Verified against Mattermost v11: a toned emoji is the base name plus
  // `_<tone>_skin_tone`. The permission prompt treats an unrecognized emoji
  // as deny, so a toned 👍 denied the tool.
  it('match their base emoji', () => {
    expect(isApprovalEmoji('+1_light_skin_tone')).toBe(true);
    expect(isApprovalEmoji('thumbsup_medium_light_skin_tone')).toBe(true);
    expect(isApprovalEmoji('+1_dark_skin_tone')).toBe(true);
    expect(isDenialEmoji('-1_medium_dark_skin_tone')).toBe(true);
    expect(isDenialEmoji('thumbsdown_medium_skin_tone')).toBe(true);
  });

  it('do not strip a name that merely ends like a tone', () => {
    expect(isApprovalEmoji('skin_tone')).toBe(false);
    expect(isApprovalEmoji('+1_skin_tone')).toBe(false);
  });
});
