/**
 * Tests for handoff logging.
 *
 * Asserts on the log lines, because the log IS the deliverable here: the tool
 * runs in the MCP child whose output never reaches the journal, so these lines
 * are the only trace a handoff leaves for an operator.
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { setLogHandler } from '../utils/logger.js';
import { noteEvent } from './observer.js';
import type { Session } from '../session/types.js';

const SHARED = 'chan-ai-work';
const THREAD = 'thread-1';

let lines: string[] = [];
setLogHandler((_level, _component, message) => {
  lines.push(message);
});
afterAll(() => setLogHandler(null));

function makeSession(present: string[] = ['rocksteady', 'april']): Session {
  return {
    sessionId: `mm:${THREAD}`,
    threadId: THREAD,
    platformId: 'mm',
    platform: {
      getMcpConfig: () => ({
        channelId: SHARED,
        teammates: [
          { name: 'rocksteady', channelId: 'chan-rock' },
          { name: 'krang', channelId: 'chan-krang' },
        ],
        teammatesPresent: present,
      }),
    } as unknown as Session['platform'],
  } as unknown as Session;
}

function toolUse(id: string, teammate: string, name = 'mcp__claude-threads-mcp__send_to_teammate') {
  return { type: 'tool_use', tool_use: { id, name, input: { teammate, message: 'yo' } } };
}

beforeEach(() => {
  lines = [];
});

describe('handoff logging', () => {
  it('logs the resolved route on the way out and on completion', () => {
    const session = makeSession();

    noteEvent(session, toolUse('t1', 'rocksteady'));
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1' } });

    expect(lines.some((l) => l.includes('Handing off to @rocksteady via thread'))).toBe(true);
    expect(lines.some((l) => l.includes('Handed off to @rocksteady via thread'))).toBe(true);
  });

  it('reports channel routing for a teammate who is not in this channel', () => {
    const session = makeSession(['rocksteady']);

    noteEvent(session, toolUse('t1', 'krang'));

    expect(lines.some((l) => l.includes('@krang via channel'))).toBe(true);
  });

  it('says so when the name is not in the registry', () => {
    const session = makeSession();

    noteEvent(session, toolUse('t1', 'shredder'));

    expect(lines.some((l) => l.includes('not in the teammate registry'))).toBe(true);
  });

  it('warns on a failed handoff', () => {
    const session = makeSession();

    noteEvent(session, toolUse('t1', 'rocksteady'));
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 't1', is_error: true } });

    expect(lines.some((l) => l.includes('Handoff to @rocksteady failed'))).toBe(true);
  });

  it('ignores unrelated tools and unknown results', () => {
    const session = makeSession();

    noteEvent(session, toolUse('t1', 'rocksteady', 'mcp__mattermost__post_message'));
    noteEvent(session, { type: 'tool_result', tool_result: { tool_use_id: 'never-seen' } });

    expect(lines).toHaveLength(0);
  });

  // Observability must never be the reason a turn breaks.
  it('survives a platform that cannot describe itself', () => {
    const broken = { threadId: THREAD, sessionId: 'mm:x', platform: {} } as unknown as Session;

    expect(() => noteEvent(broken, toolUse('t1', 'rocksteady'))).not.toThrow();
  });
});
