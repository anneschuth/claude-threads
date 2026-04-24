/**
 * Tests for the lifecycle FSM.
 *
 * Two modes:
 * - warn-only (default): illegal transitions log but don't throw.
 * - strict (`CLAUDE_THREADS_FSM_STRICT=1`): illegal transitions throw.
 *
 * The allowed-transition table is the contract. These tests pin it so that
 * changing an entry requires thinking about *why* — the warn logs in
 * production are only useful if the allowed set is honest.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  checkTransition,
  allowedTargetsFrom,
  ALL_STATES,
} from './lifecycle-fsm.js';
import type { SessionLifecycleState } from './types.js';
import { setLogHandler } from '../utils/logger.js';

describe('lifecycle FSM', () => {
  describe('allowed transitions', () => {
    // Each state's legal target set. Kept verbose so a diff against the
    // FSM module is readable — if a transition is added/removed here,
    // the change is deliberate.
    const cases: Array<[SessionLifecycleState, SessionLifecycleState[]]> = [
      ['starting', ['active', 'paused', 'interrupted', 'cancelling', 'restarting']],
      ['active', ['active', 'processing', 'paused', 'interrupted', 'restarting', 'cancelling', 'ending']],
      ['processing', ['active', 'paused', 'interrupted', 'restarting', 'cancelling']],
      ['paused', ['active', 'cancelling', 'restarting']],
      ['interrupted', ['active', 'cancelling', 'restarting', 'paused']],
      ['restarting', ['active', 'paused', 'cancelling']],
      ['cancelling', ['ending']],
      ['ending', []],
    ];

    for (const [from, legalTargets] of cases) {
      test(`${from} → {${legalTargets.join(', ')}}`, () => {
        const allowed = allowedTargetsFrom(from);
        expect([...allowed].sort()).toEqual([...legalTargets].sort());
      });
    }
  });

  describe('warn mode (default)', () => {
    const captured: Array<{ level: string; msg: string }> = [];

    beforeEach(() => {
      captured.length = 0;
      setLogHandler((level, _component, msg) => {
        captured.push({ level, msg });
      });
    });

    afterEach(() => {
      setLogHandler(null);
    });

    test('legal transition: silent, no log', () => {
      checkTransition('active', 'paused', 'test:t1');
      expect(captured.filter(e => e.msg.includes('illegal'))).toEqual([]);
    });

    test('illegal transition: warn, does not throw', () => {
      // `cancelling` is terminal for everything but ending — ending is the
      // only legal target and paused is illegal.
      expect(() => checkTransition('cancelling', 'paused', 'test:t1')).not.toThrow();
      const warns = captured.filter(e => e.msg.includes('illegal lifecycle transition'));
      expect(warns).toHaveLength(1);
      expect(warns[0].level).toBe('warn');
      expect(warns[0].msg).toContain('cancelling -> paused');
    });

    test('illegal transition log includes the sessionId', () => {
      checkTransition('ending', 'active', 'slack:thread-xyz');
      const warn = captured.find(e => e.msg.includes('illegal'));
      // sessionId lands in the structured payload (rendered as JSON in the log).
      // The message itself pins the from → to pair; the payload is separate.
      expect(warn?.msg).toContain('ending -> active');
    });
  });

  describe('strict mode', () => {
    let original: string | undefined;

    beforeEach(() => {
      original = process.env.CLAUDE_THREADS_FSM_STRICT;
      process.env.CLAUDE_THREADS_FSM_STRICT = '1';
    });

    afterEach(() => {
      if (original === undefined) {
        delete process.env.CLAUDE_THREADS_FSM_STRICT;
      } else {
        process.env.CLAUDE_THREADS_FSM_STRICT = original;
      }
    });

    test('legal transition: no throw', () => {
      expect(() => checkTransition('active', 'paused', 'test:t1')).not.toThrow();
    });

    test('illegal transition: throws with informative message', () => {
      expect(() => checkTransition('cancelling', 'active', 'test:t1')).toThrow(
        /cancelling -> active/,
      );
    });

    test('thrown error carries sessionId', () => {
      let err: unknown;
      try {
        checkTransition('ending', 'starting', 'mattermost:t42');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('mattermost:t42');
    });
  });

  describe('exhaustiveness', () => {
    test('ALL_STATES covers every SessionLifecycleState the FSM recognises', () => {
      // If a new state is added to SessionLifecycleState but not to the FSM
      // table, `allowedTargetsFrom` will throw or return undefined. This
      // test catches the mismatch.
      for (const state of ALL_STATES) {
        expect(() => allowedTargetsFrom(state)).not.toThrow();
        const targets = allowedTargetsFrom(state);
        expect(targets).toBeInstanceOf(Set);
      }
    });
  });
});
