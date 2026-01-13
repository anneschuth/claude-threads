/**
 * Tests for Event Transformer
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { transformEvent, type TransformContext } from './transformer.js';
import type { ClaudeEvent } from '../claude/cli.js';
import type { PlatformFormatter } from '../platform/formatter.js';

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

describe('Event Transformer', () => {
  let ctx: TransformContext;

  beforeEach(() => {
    ctx = {
      sessionId: 'test-session',
      formatter: mockFormatter,
      toolStartTimes: new Map(),
      detailed: true,
    };
  });

  // ---------------------------------------------------------------------------
  // Assistant Events
  // ---------------------------------------------------------------------------

  describe('assistant events', () => {
    it('transforms text content', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello, world!' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toBe('Hello, world!');
    });

    it('filters out thinking tags', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello <thinking>internal thought</thinking> world!' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toBe('Hello  world!');
    });

    it('transforms tool_use in assistant message', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', id: 'tool1', input: { file_path: '/test/file.ts' } },
          ],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('Read');
    });

    it('handles thinking blocks', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Let me think about this problem...' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toContain('💭');
      expect((ops[0] as { content: string }).content).toContain('think');
    });

    it('returns empty for empty content', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: { content: [] },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool Use Events
  // ---------------------------------------------------------------------------

  describe('tool_use events', () => {
    it('transforms Read tool', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'Read', input: { file_path: '/path/file.ts' } },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('Read');
    });

    it('transforms Bash tool', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'Bash', input: { command: 'ls -la' } },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toContain('Bash');
      expect((ops[0] as { content: string }).content).toContain('ls');
    });

    it('tracks tool start time', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool123', name: 'Read', input: {} },
      };

      transformEvent(event, ctx);

      expect(ctx.toolStartTimes.has('tool123')).toBe(true);
    });

    it('handles TodoWrite specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'pending', activeForm: 'Doing task 1' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('task_list');
    });

    it('handles Task specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'Task',
          input: { description: 'Search codebase', subagent_type: 'Explore' },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('subagent');
      expect((ops[0] as { action: string }).action).toBe('start');
    });

    it('handles AskUserQuestion specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Choice',
                question: 'Which option?',
                options: [
                  { label: 'Option A', description: 'First option' },
                  { label: 'Option B', description: 'Second option' },
                ],
              },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('question');
      expect((ops[0] as { questions: unknown[] }).questions.length).toBe(1);
    });

    it('handles ExitPlanMode specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'ExitPlanMode', input: {} },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('approval');
      expect((ops[0] as { approvalType: string }).approvalType).toBe('plan');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool Result Events
  // ---------------------------------------------------------------------------

  describe('tool_result events', () => {
    it('transforms success result', () => {
      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(2);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('✓');
      expect(ops[1].type).toBe('flush');
    });

    it('transforms error result', () => {
      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: true },
      };

      const ops = transformEvent(event, ctx);

      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('❌');
      expect((ops[0] as { content: string }).content).toContain('Error');
    });

    it('includes elapsed time for long-running tools', () => {
      // Simulate tool started 5 seconds ago
      ctx.toolStartTimes.set('tool1', Date.now() - 5000);

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { content: string }).content).toContain('5s');
    });

    it('does not include elapsed time for quick tools', () => {
      // Simulate tool started 1 second ago
      ctx.toolStartTimes.set('tool1', Date.now() - 1000);

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { content: string }).content).not.toContain('s)');
    });

    it('cleans up tool start time', () => {
      ctx.toolStartTimes.set('tool1', Date.now());

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      transformEvent(event, ctx);

      expect(ctx.toolStartTimes.has('tool1')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Result Events
  // ---------------------------------------------------------------------------

  describe('result events', () => {
    it('creates flush operation', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {},
      };

      const ops = transformEvent(event, ctx);

      expect(ops.some(op => op.type === 'flush')).toBe(true);
    });

    it('creates status update with usage stats', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {
          model: 'claude-opus-4-5',
          cost_usd: 0.05,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
          },
        },
      };

      const ops = transformEvent(event, ctx);

      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
      expect((statusOp as { modelId: string }).modelId).toBe('claude-opus-4-5');
      expect((statusOp as { totalCostUSD: number }).totalCostUSD).toBe(0.05);
    });

    /**
     * Regression test: StatusUpdateOp must ALWAYS be created when Claude's turn ends.
     * This is critical because StatusUpdateOp triggers finalize() to clean up orphaned task lists.
     *
     * Bug: Previously, StatusUpdateOp was only created if result.result existed.
     * If Claude's result event didn't have that property, finalize() was never called,
     * leaving orphaned task lists visible to users.
     */
    it('ALWAYS creates status update even when result.result is missing', () => {
      // This simulates a result event without the result property
      const event: ClaudeEvent = {
        type: 'result',
        // No 'result' property - this used to cause StatusUpdateOp to not be created
      };

      const ops = transformEvent(event, ctx);

      // CRITICAL: StatusUpdateOp must be created to trigger finalize()
      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
    });

    it('ALWAYS creates status update even when result.result is empty', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {}, // Empty result object
      };

      const ops = transformEvent(event, ctx);

      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Special Tools
  // ---------------------------------------------------------------------------

  describe('TodoWrite handling', () => {
    it('creates task list operation with tasks', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
              { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
              { content: 'Task 3', status: 'pending', activeForm: 'Planning task 3' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('task_list');
      const taskOp = ops[0] as { action: string; tasks: unknown[] };
      expect(taskOp.action).toBe('update');
      expect(taskOp.tasks.length).toBe(3);
    });

    it('sets action to complete when all tasks done', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Done' },
              { content: 'Task 2', status: 'completed', activeForm: 'Done' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { action: string }).action).toBe('complete');
    });
  });

  describe('Task (subagent) handling', () => {
    it('creates subagent start operation', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'subagent-123',
          name: 'Task',
          input: {
            description: 'Search for authentication code',
            subagent_type: 'Explore',
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('subagent');
      const subOp = ops[0] as {
        toolUseId: string;
        action: string;
        description: string;
        subagentType: string;
      };
      expect(subOp.toolUseId).toBe('subagent-123');
      expect(subOp.action).toBe('start');
      expect(subOp.description).toBe('Search for authentication code');
      expect(subOp.subagentType).toBe('Explore');
    });

    it('uses prompt field if description missing', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'Task',
          input: { prompt: 'Do something' },
        },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { description: string }).description).toBe('Do something');
    });
  });

  describe('AskUserQuestion handling', () => {
    it('creates question operation with all fields', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'q-123',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Framework',
                question: 'Which framework should we use?',
                options: [
                  { label: 'React', description: 'Popular UI library' },
                  { label: 'Vue', description: 'Progressive framework' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('question');
      const qOp = ops[0] as {
        toolUseId: string;
        questions: Array<{
          header: string;
          question: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
        currentIndex: number;
      };
      expect(qOp.toolUseId).toBe('q-123');
      expect(qOp.questions.length).toBe(1);
      expect(qOp.questions[0].header).toBe('Framework');
      expect(qOp.questions[0].options.length).toBe(2);
      expect(qOp.currentIndex).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown Events
  // ---------------------------------------------------------------------------

  describe('unknown events', () => {
    it('returns empty array for unknown event types', () => {
      const event: ClaudeEvent = {
        type: 'unknown_event_type',
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(0);
    });
  });
});
