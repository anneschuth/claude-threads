import { describe, it, expect } from 'bun:test';
import {
  buildInitEvent,
  buildResultEvent,
  createTranslationState,
  translateNotification,
  CODEX_DEFAULT_CONTEXT_WINDOW,
} from './translator.js';

// Payloads below mirror real codex-cli 0.144.x app-server notifications
// (captured via a live probe and `codex app-server generate-json-schema`).

describe('translateNotification', () => {
  describe('item/completed', () => {
    it('translates agentMessage to an assistant text event', () => {
      const state = createTranslationState('gpt-5.5-codex');
      const events = translateNotification('item/completed', {
        item: { type: 'agentMessage', id: 'msg_1', text: 'probe-ok', phase: 'final_answer' },
      }, state);

      expect(events).toEqual([{
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'probe-ok' }] },
      }]);
    });

    it('skips empty agentMessage items', () => {
      const state = createTranslationState();
      expect(translateNotification('item/completed', {
        item: { type: 'agentMessage', id: 'msg_1', text: '' },
      }, state)).toEqual([]);
    });

    it('translates reasoning summary to a thinking block', () => {
      const state = createTranslationState();
      const events = translateNotification('item/completed', {
        item: { type: 'reasoning', id: 'r1', summary: ['Examining the repo', 'Planning next step'] },
      }, state);

      expect(events).toEqual([{
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Examining the repo\n\nPlanning next step' }] },
      }]);
    });

    it('translates completed commandExecution to a successful tool_result', () => {
      const state = createTranslationState();
      const events = translateNotification('item/completed', {
        item: { type: 'commandExecution', id: 'exec-1', command: '/bin/zsh -lc \'echo hi\'', status: 'completed', exitCode: 0 },
      }, state);

      expect(events).toEqual([{
        type: 'tool_result',
        tool_result: { tool_use_id: 'exec-1', is_error: false },
      }]);
    });

    it('marks failed commandExecution as error result', () => {
      const state = createTranslationState();
      const events = translateNotification('item/completed', {
        item: { type: 'commandExecution', id: 'exec-1', command: 'x', status: 'failed', exitCode: 1 },
      }, state);

      expect(events[0].tool_result).toEqual({ tool_use_id: 'exec-1', is_error: true });
    });

    it('emits one tool_result per file change', () => {
      const state = createTranslationState();
      const events = translateNotification('item/completed', {
        item: {
          type: 'fileChange',
          id: 'fc-1',
          status: 'completed',
          changes: [
            { path: '/a.ts', kind: { type: 'add' }, diff: '+x' },
            { path: '/b.ts', kind: { type: 'update' }, diff: '-y' },
          ],
        },
      }, state);

      expect(events).toEqual([
        { type: 'tool_result', tool_result: { tool_use_id: 'fc-1:0', is_error: false } },
        { type: 'tool_result', tool_result: { tool_use_id: 'fc-1:1', is_error: false } },
      ]);
    });
  });

  describe('item/started', () => {
    it('translates commandExecution to a Bash tool_use with unwrapped command', () => {
      const state = createTranslationState();
      const events = translateNotification('item/started', {
        item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'echo probe-ok'", status: 'inProgress' },
      }, state);

      expect(events).toEqual([{
        type: 'tool_use',
        tool_use: { id: 'exec-1', name: 'Bash', input: { command: 'echo probe-ok' } },
      }]);
    });

    it('translates fileChange additions to Write and updates to Edit tool_use', () => {
      const state = createTranslationState();
      const events = translateNotification('item/started', {
        item: {
          type: 'fileChange',
          id: 'fc-1',
          status: 'inProgress',
          changes: [
            { path: '/new.ts', kind: { type: 'add' } },
            { path: '/old.ts', kind: { type: 'update' } },
          ],
        },
      }, state);

      expect(events).toEqual([
        { type: 'tool_use', tool_use: { id: 'fc-1:0', name: 'Write', input: { file_path: '/new.ts' } } },
        { type: 'tool_use', tool_use: { id: 'fc-1:1', name: 'Edit', input: { file_path: '/old.ts' } } },
      ]);
    });

    it('translates webSearch to a WebSearch tool_use', () => {
      const state = createTranslationState();
      const events = translateNotification('item/started', {
        item: { type: 'webSearch', id: 'ws-1', query: 'bun test runner' },
      }, state);

      expect(events).toEqual([{
        type: 'tool_use',
        tool_use: { id: 'ws-1', name: 'WebSearch', input: { query: 'bun test runner' } },
      }]);
    });

    it('translates mcpToolCall to an mcp__ prefixed tool_use', () => {
      const state = createTranslationState();
      const events = translateNotification('item/started', {
        item: { type: 'mcpToolCall', id: 'mcp-1', server: 'github', tool: 'create_pr', arguments: { title: 'x' } },
      }, state);

      expect(events).toEqual([{
        type: 'tool_use',
        tool_use: { id: 'mcp-1', name: 'mcp__github__create_pr', input: { title: 'x' } },
      }]);
    });

    it('ignores userMessage echoes', () => {
      const state = createTranslationState();
      expect(translateNotification('item/started', {
        item: { type: 'userMessage', id: 'u1', content: [] },
      }, state)).toEqual([]);
    });
  });

  describe('turn/plan/updated', () => {
    it('maps plan steps onto the TodoWrite shape', () => {
      const state = createTranslationState();
      const events = translateNotification('turn/plan/updated', {
        plan: [
          { step: 'Read files', status: 'completed' },
          { step: 'Fix bug', status: 'inProgress' },
          { step: 'Run tests', status: 'pending' },
        ],
      }, state);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_use');
      const toolUse = events[0].tool_use as { name: string; input: { todos: unknown[] } };
      expect(toolUse.name).toBe('TodoWrite');
      expect(toolUse.input.todos).toEqual([
        { content: 'Read files', status: 'completed', activeForm: 'Read files' },
        { content: 'Fix bug', status: 'in_progress', activeForm: 'Fix bug' },
        { content: 'Run tests', status: 'pending', activeForm: 'Run tests' },
      ]);
    });
  });

  describe('token usage and turn completion', () => {
    const tokenUsagePayload = {
      tokenUsage: {
        total: { totalTokens: 25592, inputTokens: 25476, cachedInputTokens: 22016, outputTokens: 116 },
        last: { totalTokens: 12812, inputTokens: 12806, cachedInputTokens: 12032, outputTokens: 6 },
        modelContextWindow: 353400,
      },
    };

    it('stores token usage in state without emitting events', () => {
      const state = createTranslationState('gpt-5.5-codex');
      const events = translateNotification('thread/tokenUsage/updated', tokenUsagePayload, state);

      expect(events).toEqual([]);
      expect(state.tokenUsage).toEqual(tokenUsagePayload.tokenUsage);
    });

    it('synthesizes a result event with cumulative modelUsage on turn/completed', () => {
      const state = createTranslationState('gpt-5.5-codex');
      translateNotification('thread/tokenUsage/updated', tokenUsagePayload, state);

      const events = translateNotification('turn/completed', {
        turn: { id: 't1', status: 'completed', error: null },
      }, state);

      expect(events).toHaveLength(1);
      const result = events[0];
      expect(result.type).toBe('result');
      // Per-request usage (last turn) with cached tokens split out
      expect(result.usage).toEqual({
        input_tokens: 12806 - 12032,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 12032,
        output_tokens: 6,
      });
      // Cumulative per-model usage — REQUIRED or updateUsageStats early-returns
      expect(result.modelUsage).toEqual({
        'gpt-5.5-codex': {
          inputTokens: 25476 - 22016,
          outputTokens: 116,
          cacheReadInputTokens: 22016,
          cacheCreationInputTokens: 0,
          contextWindow: 353400,
          costUSD: 0,
        },
      });
      expect(result.total_cost_usd).toBe(0);
    });

    it('adds a system error event when the turn failed', () => {
      const state = createTranslationState();
      const events = translateNotification('turn/completed', {
        turn: { id: 't1', status: 'failed', error: { message: 'usage limit exceeded' } },
      }, state);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'system', subtype: 'error', error: 'usage limit exceeded' });
      expect(events[1].type).toBe('result');
    });

    it('falls back to the default context window without token usage', () => {
      const state = createTranslationState('gpt-5.5-codex');
      const result = buildResultEvent(state);
      const modelUsage = result.modelUsage as Record<string, { contextWindow: number }>;
      expect(modelUsage['gpt-5.5-codex'].contextWindow).toBe(CODEX_DEFAULT_CONTEXT_WINDOW);
    });
  });

  describe('error notification', () => {
    it('translates non-retryable errors to system error events', () => {
      const state = createTranslationState();
      const events = translateNotification('error', {
        error: { message: 'unauthorized' },
        willRetry: false,
      }, state);

      expect(events).toEqual([{ type: 'system', subtype: 'error', error: 'unauthorized' }]);
    });

    it('suppresses retryable errors', () => {
      const state = createTranslationState();
      expect(translateNotification('error', {
        error: { message: 'server overloaded' },
        willRetry: true,
      }, state)).toEqual([]);
    });
  });

  describe('unknown notifications', () => {
    it('returns no events', () => {
      const state = createTranslationState();
      expect(translateNotification('account/rateLimits/updated', {}, state)).toEqual([]);
      expect(translateNotification('thread/status/changed', {}, state)).toEqual([]);
      expect(translateNotification('item/agentMessage/delta', { delta: 'x' }, state)).toEqual([]);
    });
  });
});

describe('buildInitEvent', () => {
  it('carries the codex threadId as session_id', () => {
    expect(buildInitEvent('thr_123', 'gpt-5.5-codex')).toEqual({
      type: 'system',
      subtype: 'init',
      session_id: 'thr_123',
      model: 'gpt-5.5-codex',
    });
  });
});
