/**
 * Tests for TaskTracker - incremental TaskCreate/TaskUpdate state.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { TaskTracker } from './task-tracker.js';

describe('TaskTracker', () => {
  let tracker: TaskTracker;

  beforeEach(() => {
    tracker = new TaskTracker();
  });

  it('starts empty', () => {
    expect(tracker.isEmpty).toBe(true);
    expect(tracker.allCompleted).toBe(false);
    expect(tracker.toTaskItems()).toEqual([]);
  });

  it('creates tasks as pending', () => {
    tracker.create('tu-1', { subject: 'do things', description: 'd' });
    expect(tracker.toTaskItems()).toEqual([
      { content: 'do things', status: 'pending', activeForm: 'do things' },
    ]);
  });

  it('resolves the real id from the tool result and applies updates by it', () => {
    tracker.create('tu-1', { subject: 'do things', description: 'd' });
    expect(tracker.resolveCreatedId('tu-1', 'Task #12 created successfully: do things')).toBe('resolved');

    expect(tracker.update({ taskId: '12', status: 'in_progress' })).toBe(true);
    expect(tracker.toTaskItems()[0].status).toBe('in_progress');
  });

  it('ignores results for unknown tool_use ids', () => {
    expect(tracker.resolveCreatedId('nope', 'Task #1 created successfully: x')).toBe('ignored');
  });

  it('removes the task when the create result does not match', () => {
    tracker.create('tu-1', { subject: 'x', description: 'd' });
    expect(tracker.resolveCreatedId('tu-1', 'Some unexpected wording')).toBe('removed');
    // No ghost row left behind, and allCompleted is not poisoned
    expect(tracker.isEmpty).toBe(true);
    // A later (unrelated) result with a matching text must not attach to it
    expect(tracker.resolveCreatedId('tu-1', 'Task #1 created successfully: x')).toBe('ignored');
  });

  it('removes the task when the create result is an error', () => {
    tracker.create('tu-1', { subject: 'x', description: 'd' });
    // Error content could even contain a matching-looking string; is_error wins
    expect(tracker.resolveCreatedId('tu-1', 'Task #1 created successfully: x', true)).toBe('removed');
    expect(tracker.isEmpty).toBe(true);
  });

  it('merges a placeholder created by an early update into the resolved task', () => {
    tracker.create('tu-1', { subject: 'real subject', description: 'd' });
    // An update for id 3 arrives before the create's result resolves it
    tracker.update({ taskId: '3', status: 'in_progress' });
    expect(tracker.toTaskItems()).toHaveLength(2);

    expect(tracker.resolveCreatedId('tu-1', 'Task #3 created successfully: real subject')).toBe('resolved');

    // One row: real subject, placeholder's status adopted
    expect(tracker.toTaskItems()).toEqual([
      { content: 'real subject', status: 'in_progress', activeForm: 'real subject' },
    ]);
    // And it stays reachable by id
    tracker.update({ taskId: '3', status: 'completed' });
    expect(tracker.allCompleted).toBe(true);
  });

  it('creates a placeholder for updates to unknown task ids', () => {
    tracker.update({ taskId: '7', status: 'completed' });
    expect(tracker.toTaskItems()).toEqual([
      { content: 'Task #7', status: 'completed', activeForm: 'Task #7' },
    ]);
  });

  it('applies subject and activeForm updates', () => {
    tracker.create('tu-1', { subject: 'old', description: 'd' });
    tracker.resolveCreatedId('tu-1', 'Task #1 created successfully: old');
    tracker.update({ taskId: '1', subject: 'new name', activeForm: 'renaming' });
    expect(tracker.toTaskItems()[0]).toEqual({
      content: 'new name',
      status: 'pending',
      activeForm: 'renaming',
    });
  });

  it('deletes tasks on status deleted', () => {
    tracker.create('tu-1', { subject: 'a', description: 'd' });
    tracker.create('tu-2', { subject: 'b', description: 'd' });
    tracker.resolveCreatedId('tu-1', 'Task #1 created successfully: a');
    tracker.update({ taskId: '1', status: 'deleted' });
    expect(tracker.toTaskItems()).toEqual([
      { content: 'b', status: 'pending', activeForm: 'b' },
    ]);
  });

  it('reports allCompleted only when every task is completed', () => {
    tracker.create('tu-1', { subject: 'a', description: 'd' });
    tracker.create('tu-2', { subject: 'b', description: 'd' });
    tracker.resolveCreatedId('tu-1', 'Task #1 created successfully: a');
    tracker.resolveCreatedId('tu-2', 'Task #2 created successfully: b');

    tracker.update({ taskId: '1', status: 'completed' });
    expect(tracker.allCompleted).toBe(false);
    tracker.update({ taskId: '2', status: 'completed' });
    expect(tracker.allCompleted).toBe(true);
  });

  it('clear() resets everything', () => {
    tracker.create('tu-1', { subject: 'a', description: 'd' });
    tracker.clear();
    expect(tracker.isEmpty).toBe(true);
    expect(tracker.resolveCreatedId('tu-1', 'Task #1 created successfully: a')).toBe('ignored');
  });
});
