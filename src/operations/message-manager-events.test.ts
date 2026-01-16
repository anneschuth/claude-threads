/**
 * Tests for TypedEventEmitter and message manager events
 *
 * Tests the type-safe event emitter pattern used for MessageManager.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  TypedEventEmitter,
  createMessageManagerEvents,
  type MessageManagerEventMap,
} from './message-manager-events.js';

// =============================================================================
// Tests
// =============================================================================

describe('TypedEventEmitter', () => {
  let emitter: TypedEventEmitter;

  beforeEach(() => {
    emitter = createMessageManagerEvents();
  });

  // ---------------------------------------------------------------------------
  // Basic Event Operations
  // ---------------------------------------------------------------------------

  describe('emit and on', () => {
    it('emits and receives question:complete event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['question:complete'] = {
        toolUseId: 'tool-1',
        answers: [{ header: 'Q1', answer: 'A1' }],
      };

      emitter.on('question:complete', handler);
      const result = emitter.emit('question:complete', payload);

      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives approval:complete event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['approval:complete'] = {
        toolUseId: 'tool-2',
        approved: true,
      };

      emitter.on('approval:complete', handler);
      emitter.emit('approval:complete', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives message-approval:complete event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['message-approval:complete'] = {
        decision: 'allow',
        fromUser: 'testuser',
        originalMessage: 'Hello',
        approvedBy: 'approver',
      };

      emitter.on('message-approval:complete', handler);
      emitter.emit('message-approval:complete', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives context-prompt:complete event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['context-prompt:complete'] = {
        selection: 1,
        queuedPrompt: 'original prompt',
        threadMessageCount: 5,
      };

      emitter.on('context-prompt:complete', handler);
      emitter.emit('context-prompt:complete', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives worktree-prompt:complete event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['worktree-prompt:complete'] = {
        decision: 'join',
        branch: 'feature-branch',
        worktreePath: '/path/to/worktree',
        username: 'testuser',
      };

      emitter.on('worktree-prompt:complete', handler);
      emitter.emit('worktree-prompt:complete', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives update-prompt:complete event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['update-prompt:complete'] = {
        decision: 'update_now',
      };

      emitter.on('update-prompt:complete', handler);
      emitter.emit('update-prompt:complete', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives worktree-initial-prompt:complete event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['worktree-initial-prompt:complete'] = {
        decision: { type: 'branch_selected', branch: 'my-branch' },
        queuedPrompt: 'queued message',
      };

      emitter.on('worktree-initial-prompt:complete', handler);
      emitter.emit('worktree-initial-prompt:complete', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives bug-report:complete event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['bug-report:complete'] = {
        decision: 'approve',
        report: {
          postId: 'post-1',
          title: 'Bug Report Title',
          body: 'Bug report body content',
          userDescription: 'User description of the bug',
          imageUrls: [],
          imageErrors: [],
          errorContext: {
            postId: 'error-post-1',
            message: 'Test error',
            timestamp: new Date(),
          },
        },
      };

      emitter.on('bug-report:complete', handler);
      emitter.emit('bug-report:complete', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives status:update event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['status:update'] = {
        contextTokens: 50000,
        modelDisplayName: 'Sonnet',
      };

      emitter.on('status:update', handler);
      emitter.emit('status:update', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('emits and receives lifecycle:event event', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['lifecycle:event'] = {
        event: 'idle',
      };

      emitter.on('lifecycle:event', handler);
      emitter.emit('lifecycle:event', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('returns false when no listeners', () => {
      const result = emitter.emit('question:complete', {
        toolUseId: 'test',
        answers: [],
      });

      expect(result).toBe(false);
    });

    it('supports multiple listeners for same event', () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});
      const payload: MessageManagerEventMap['approval:complete'] = {
        toolUseId: 'tool-1',
        approved: false,
      };

      emitter.on('approval:complete', handler1);
      emitter.on('approval:complete', handler2);
      emitter.emit('approval:complete', payload);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Once
  // ---------------------------------------------------------------------------

  describe('once', () => {
    it('listener fires only once', () => {
      const handler = mock(() => {});
      const payload: MessageManagerEventMap['question:complete'] = {
        toolUseId: 'tool-1',
        answers: [],
      };

      emitter.once('question:complete', handler);
      emitter.emit('question:complete', payload);
      emitter.emit('question:complete', payload);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns emitter for chaining', () => {
      const handler = mock(() => {});
      const result = emitter.once('approval:complete', handler);

      expect(result).toBe(emitter);
    });
  });

  // ---------------------------------------------------------------------------
  // Off
  // ---------------------------------------------------------------------------

  describe('off', () => {
    it('removes specific listener', () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});

      emitter.on('question:complete', handler1);
      emitter.on('question:complete', handler2);
      emitter.off('question:complete', handler1);
      emitter.emit('question:complete', { toolUseId: 'test', answers: [] });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('returns emitter for chaining', () => {
      const handler = mock(() => {});
      emitter.on('approval:complete', handler);
      const result = emitter.off('approval:complete', handler);

      expect(result).toBe(emitter);
    });
  });

  // ---------------------------------------------------------------------------
  // RemoveAllListeners
  // ---------------------------------------------------------------------------

  describe('removeAllListeners', () => {
    it('removes all listeners for specific event', () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});
      const handler3 = mock(() => {});

      emitter.on('question:complete', handler1);
      emitter.on('question:complete', handler2);
      emitter.on('approval:complete', handler3);

      emitter.removeAllListeners('question:complete');

      emitter.emit('question:complete', { toolUseId: 'test', answers: [] });
      emitter.emit('approval:complete', { toolUseId: 'test', approved: true });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('removes all listeners when no event specified', () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});

      emitter.on('question:complete', handler1);
      emitter.on('approval:complete', handler2);

      emitter.removeAllListeners();

      emitter.emit('question:complete', { toolUseId: 'test', answers: [] });
      emitter.emit('approval:complete', { toolUseId: 'test', approved: true });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('returns emitter for chaining', () => {
      const result = emitter.removeAllListeners('question:complete');
      expect(result).toBe(emitter);
    });
  });

  // ---------------------------------------------------------------------------
  // ListenerCount
  // ---------------------------------------------------------------------------

  describe('listenerCount', () => {
    it('returns 0 when no listeners', () => {
      expect(emitter.listenerCount('question:complete')).toBe(0);
    });

    it('returns correct count', () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});

      emitter.on('question:complete', handler1);
      emitter.on('question:complete', handler2);

      expect(emitter.listenerCount('question:complete')).toBe(2);
    });

    it('decrements after removal', () => {
      const handler = mock(() => {});

      emitter.on('question:complete', handler);
      expect(emitter.listenerCount('question:complete')).toBe(1);

      emitter.off('question:complete', handler);
      expect(emitter.listenerCount('question:complete')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Chaining
  // ---------------------------------------------------------------------------

  describe('method chaining', () => {
    it('supports chaining on and once', () => {
      const h1 = mock(() => {});
      const h2 = mock(() => {});

      emitter
        .on('question:complete', h1)
        .once('approval:complete', h2);

      expect(emitter.listenerCount('question:complete')).toBe(1);
      expect(emitter.listenerCount('approval:complete')).toBe(1);
    });
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createMessageManagerEvents', () => {
  it('creates a new TypedEventEmitter instance', () => {
    const emitter = createMessageManagerEvents();

    expect(emitter).toBeInstanceOf(TypedEventEmitter);
  });

  it('creates independent instances', () => {
    const emitter1 = createMessageManagerEvents();
    const emitter2 = createMessageManagerEvents();

    const handler = mock(() => {});
    emitter1.on('question:complete', handler);

    emitter2.emit('question:complete', { toolUseId: 'test', answers: [] });

    // Handler on emitter1 should not be called by emitter2's emit
    expect(handler).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Event Payload Types Tests
// =============================================================================

describe('Event Payload Types', () => {
  let emitter: TypedEventEmitter;

  beforeEach(() => {
    emitter = createMessageManagerEvents();
  });

  it('handles context-prompt:complete with timeout selection', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['context-prompt:complete'] = {
      selection: 'timeout',
      queuedPrompt: 'prompt',
      threadMessageCount: 10,
    };

    emitter.on('context-prompt:complete', handler);
    emitter.emit('context-prompt:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
    expect((handler.mock.calls[0] as any)[0].selection).toBe('timeout');
  });

  it('handles context-prompt:complete with optional files', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['context-prompt:complete'] = {
      selection: 2,
      queuedPrompt: 'prompt',
      queuedFiles: [{ id: 'file-1', name: 'test.txt' }],
      threadMessageCount: 5,
    };

    emitter.on('context-prompt:complete', handler);
    emitter.emit('context-prompt:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handles worktree-initial-prompt:complete with skip decision', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['worktree-initial-prompt:complete'] = {
      decision: { type: 'skip' },
    };

    emitter.on('worktree-initial-prompt:complete', handler);
    emitter.emit('worktree-initial-prompt:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handles worktree-initial-prompt:complete with retry decision', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['worktree-initial-prompt:complete'] = {
      decision: { type: 'retry', branchName: 'custom-branch' },
      failedBranch: 'failed-branch',
    };

    emitter.on('worktree-initial-prompt:complete', handler);
    emitter.emit('worktree-initial-prompt:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handles message-approval:complete with deny decision', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['message-approval:complete'] = {
      decision: 'deny',
      fromUser: 'unauthorized',
      originalMessage: 'blocked message',
      approvedBy: 'moderator',
    };

    emitter.on('message-approval:complete', handler);
    emitter.emit('message-approval:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handles message-approval:complete with invite decision', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['message-approval:complete'] = {
      decision: 'invite',
      fromUser: 'newuser',
      originalMessage: 'request to join',
      approvedBy: 'admin',
    };

    emitter.on('message-approval:complete', handler);
    emitter.emit('message-approval:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handles worktree-prompt:complete with skip decision', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['worktree-prompt:complete'] = {
      decision: 'skip',
      branch: 'existing-branch',
      worktreePath: '/path',
      username: 'user',
    };

    emitter.on('worktree-prompt:complete', handler);
    emitter.emit('worktree-prompt:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handles update-prompt:complete with defer decision', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['update-prompt:complete'] = {
      decision: 'defer',
    };

    emitter.on('update-prompt:complete', handler);
    emitter.emit('update-prompt:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handles bug-report:complete with deny decision', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['bug-report:complete'] = {
      decision: 'deny',
      report: {
        postId: 'post-1',
        title: 'Bug Report',
        body: 'Report body',
        userDescription: 'User description',
        imageUrls: [],
        imageErrors: [],
        errorContext: {
          postId: 'error-post-1',
          message: 'Error message',
          timestamp: new Date(),
        },
      },
    };

    emitter.on('bug-report:complete', handler);
    emitter.emit('bug-report:complete', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handles lifecycle:event with processing state', () => {
    const handler = mock(() => {});
    const payload: MessageManagerEventMap['lifecycle:event'] = {
      event: 'processing',
    };

    emitter.on('lifecycle:event', handler);
    emitter.emit('lifecycle:event', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });
});
