/**
 * Tests for MessageApprovalExecutor
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageApprovalExecutor } from './message-approval.js';
import { createTestContext } from '../../test-utils/executor-harness.js';
import type { ExecutorContext, PendingMessageApproval } from './types.js';
import { createMessageManagerEvents } from '../message-manager-events.js';

describe('MessageApprovalExecutor', () => {
  let executor: MessageApprovalExecutor;
  let ctx: ExecutorContext;
  let messageApprovalCompleted: { decision: string; fromUser: string; originalMessage: string; approvedBy: string } | null;

  beforeEach(() => {
    messageApprovalCompleted = null;

    // Create event emitter and subscribe to events
    const events = createMessageManagerEvents();
    events.on('message-approval:complete', ({ decision, fromUser, originalMessage, approvedBy }) => {
      messageApprovalCompleted = { decision, fromUser, originalMessage, approvedBy };
    });

    executor = new MessageApprovalExecutor({
      registerPost: (_postId, _options) => {},
      updateLastMessage: (_post) => {},
      events,
    });

    ctx = createTestContext();
  });

  describe('Message Approval Operations', () => {
    it('sets pending message approval', () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      expect(executor.hasPendingMessageApproval()).toBe(true);
      expect(executor.getPendingMessageApproval()).toEqual(approval);
    });

    it('handles allow decision', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleMessageApprovalResponse(
        'post-123',
        'allow',
        'approver-user',
        ctx
      );

      expect(handled).toBe(true);
      expect(executor.hasPendingMessageApproval()).toBe(false);
      expect(messageApprovalCompleted).not.toBeNull();
      expect(messageApprovalCompleted!.decision).toBe('allow');
      expect(messageApprovalCompleted!.fromUser).toBe('unauthorized-user');
      expect(messageApprovalCompleted!.originalMessage).toBe('Hello world');
      expect(messageApprovalCompleted!.approvedBy).toBe('approver-user');
    });

    it('handles invite decision', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleMessageApprovalResponse(
        'post-123',
        'invite',
        'approver-user',
        ctx
      );

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('invite');
      expect(messageApprovalCompleted!.approvedBy).toBe('approver-user');
    });

    it('handles deny decision', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleMessageApprovalResponse(
        'post-123',
        'deny',
        'approver-user',
        ctx
      );

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('deny');
      expect(messageApprovalCompleted!.approvedBy).toBe('approver-user');
    });

    it('ignores response for wrong post', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleMessageApprovalResponse(
        'wrong-post-id',
        'allow',
        'approver-user',
        ctx
      );

      expect(handled).toBe(false);
      expect(executor.hasPendingMessageApproval()).toBe(true);
    });
  });

  describe('State Management', () => {
    it('clears pending message approval', () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);
      expect(executor.hasPendingMessageApproval()).toBe(true);

      executor.clearPendingMessageApproval();
      expect(executor.hasPendingMessageApproval()).toBe(false);
    });

    it('resets state correctly', () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);
      expect(executor.hasPendingMessageApproval()).toBe(true);

      executor.reset();
      expect(executor.hasPendingMessageApproval()).toBe(false);
    });

    it('hydrates state from persisted data', () => {
      const persisted = {
        pendingMessageApproval: {
          postId: 'post-456',
          fromUser: 'persisted-user',
          originalMessage: 'Persisted message',
        },
      };

      executor.hydrateState(persisted);

      expect(executor.hasPendingMessageApproval()).toBe(true);
      expect(executor.getPendingMessageApproval()?.fromUser).toBe('persisted-user');
    });
  });

  describe('Reaction Handling', () => {
    it('handles approval emoji reaction', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleReaction('post-123', '+1', 'approver', 'added', ctx);

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('allow');
    });

    it('handles invite emoji reaction', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleReaction('post-123', 'white_check_mark', 'approver', 'added', ctx);

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('invite');
    });

    it('handles denial emoji reaction', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleReaction('post-123', '-1', 'approver', 'added', ctx);

      expect(handled).toBe(true);
      expect(messageApprovalCompleted!.decision).toBe('deny');
    });

    it('ignores removed reactions', async () => {
      const approval: PendingMessageApproval = {
        postId: 'post-123',
        fromUser: 'unauthorized-user',
        originalMessage: 'Hello world',
      };

      executor.setPendingMessageApproval(approval);

      const handled = await executor.handleReaction('post-123', '+1', 'approver', 'removed', ctx);

      expect(handled).toBe(false);
      expect(executor.hasPendingMessageApproval()).toBe(true);
    });
  });
});
