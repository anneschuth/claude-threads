/**
 * Task List Executor - Handles TaskListOp
 *
 * Responsible for:
 * - Creating and updating task list posts
 * - Bumping task list to bottom of thread
 * - Toggle minimize state
 * - Tracking in-progress task timing
 */

import type { PlatformFormatter } from '../../platform/index.js';
import { MINIMIZE_TOGGLE_EMOJIS, isMinimizeToggleEmoji } from '../../utils/emoji.js';
import { formatShortId } from '../../utils/format.js';
import type { TaskListOp, TaskItem } from '../types.js';
import type { ExecutorContext, TaskListState } from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

// ---------------------------------------------------------------------------
// Task List Executor
// ---------------------------------------------------------------------------

/**
 * Executor for task list operations.
 *
 * Bump operations are serialized to prevent race conditions where simultaneous
 * calls could create duplicate task posts. The bumpQueue ensures only one bump
 * operation runs at a time.
 */
export class TaskListExecutor extends BaseExecutor<TaskListState> {
  /**
   * Queue for serializing bump operations. Each bump waits for previous bumps
   * to complete before starting, preventing race conditions.
   */
  private bumpQueue: Promise<void> = Promise.resolve();

  constructor(options: ExecutorOptions) {
    super(options, TaskListExecutor.createInitialState());
  }

  private static createInitialState(): TaskListState {
    return {
      tasksPostId: null,
      lastTasksContent: null,
      tasksCompleted: false,
      tasksMinimized: false,
      inProgressTaskStart: null,
    };
  }

  protected getInitialState(): TaskListState {
    return TaskListExecutor.createInitialState();
  }

  /**
   * Hydrate state from persisted session data.
   * Used when resuming a session after bot restart.
   */
  hydrateState(persisted: {
    tasksPostId?: string | null;
    lastTasksContent?: string | null;
    tasksCompleted?: boolean;
    tasksMinimized?: boolean;
  }): void {
    this.state = {
      tasksPostId: persisted.tasksPostId ?? null,
      lastTasksContent: persisted.lastTasksContent ?? null,
      tasksCompleted: persisted.tasksCompleted ?? false,
      tasksMinimized: persisted.tasksMinimized ?? false,
      inProgressTaskStart: null, // Not persisted
    };
  }

  /**
   * Get current tasks post ID (for bumping from content executor).
   */
  getTasksPostId(): string | null {
    return this.state.tasksPostId;
  }

  /**
   * Check if there's an active task list that should be bumped.
   */
  hasActiveTasks(): boolean {
    return !!(this.state.tasksPostId && this.state.lastTasksContent && !this.state.tasksCompleted);
  }

  /**
   * Execute a task list operation.
   */
  async execute(op: TaskListOp, ctx: ExecutorContext): Promise<void> {
    
    switch (op.action) {
      case 'update':
        await this.updateTaskList(op.tasks, ctx);
        break;

      case 'complete':
        await this.completeTaskList(op.tasks, ctx);
        break;

      case 'bump_to_bottom':
        await this.bumpToBottom(ctx);
        break;

      case 'toggle_minimize':
        await this.toggleMinimize(ctx);
        break;

      default:
        ctx.logger.warn(`Unknown task list action: ${op.action}`);
    }
  }

  /**
   * Update the task list.
   */
  private async updateTaskList(tasks: TaskItem[], ctx: ExecutorContext): Promise<void> {
    // Log task summary
    const statusCounts = tasks.reduce(
      (acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    ctx.logger.debug(
      `TodoWrite: ${tasks.length} tasks (${Object.entries(statusCounts).map(([s, c]) => `${s}:${c}`).join(', ')})`
    );

    // Track in-progress task timing
    const inProgressTask = tasks.find(t => t.status === 'in_progress');
    if (inProgressTask && !this.state.inProgressTaskStart) {
      this.state.inProgressTaskStart = Date.now();
    } else if (!inProgressTask) {
      this.state.inProgressTaskStart = null;
    }

    // Format task list content
    const content = this.formatTaskList(tasks, ctx.formatter);
    this.state.lastTasksContent = content;
    this.state.tasksCompleted = false;

    // Get display content (minimized or full)
    const displayContent = this.state.tasksMinimized
      ? this.getMinimizedContent(content, ctx.formatter)
      : content;

    if (this.state.tasksPostId) {
      // Update existing post
      try {
        await ctx.platform.updatePost(this.state.tasksPostId, displayContent);
        ctx.threadLogger?.logExecutor('task_list', 'update', this.state.tasksPostId, undefined, 'updateTaskList');
      } catch (err) {
        ctx.logger.debug(`Failed to update task post: ${err}`);
        ctx.threadLogger?.logExecutor('task_list', 'error', this.state.tasksPostId, { failedOp: 'updatePost', error: String(err) }, 'updateTaskList');
        // Try to delete the old post to avoid duplicate task lists visible to users
        const oldPostId = this.state.tasksPostId;
        try {
          await ctx.platform.deletePost(oldPostId);
          ctx.threadLogger?.logExecutor('task_list', 'delete', oldPostId, { reason: 'update_failed_recovery' }, 'updateTaskList');
          // Delete succeeded, now create new post
          await this.createTaskPost(displayContent, ctx);
        } catch (deleteErr) {
          // Delete also failed - DON'T create new post to prevent duplicates!
          // The old post might still exist on the platform.
          // Set tasksPostId to null so next update creates fresh post.
          ctx.logger.warn(`Failed to delete old task post ${oldPostId.substring(0, 8)}: ${deleteErr}. Not creating new post to prevent duplicates.`);
          ctx.threadLogger?.logExecutor('task_list', 'error', oldPostId, { failedOp: 'deletePost', error: String(deleteErr), context: 'after_update_failed' }, 'updateTaskList');
          this.state.tasksPostId = null;
        }
      }
    } else {
      // Create new post
      await this.createTaskPost(displayContent, ctx);
    }
  }

  /**
   * Mark task list as completed.
   */
  private async completeTaskList(tasks: TaskItem[], ctx: ExecutorContext): Promise<void> {
    ctx.logger.debug(`TodoWrite: All ${tasks.length} tasks completed`);

    // Format final task list
    const content = this.formatTaskList(tasks, ctx.formatter);
    this.state.lastTasksContent = content;
    this.state.tasksCompleted = true;
    this.state.inProgressTaskStart = null;

    // Always show full list when completed
    if (this.state.tasksPostId) {
      try {
        await ctx.platform.updatePost(this.state.tasksPostId, content);
        ctx.threadLogger?.logExecutor('task_list', 'complete', this.state.tasksPostId, { taskCount: tasks.length }, 'completeTaskList');
        // Unpin completed task list
        await ctx.platform.unpinPost(this.state.tasksPostId).catch(() => {});
      } catch (err) {
        ctx.threadLogger?.logExecutor('task_list', 'error', this.state.tasksPostId, { failedOp: 'updatePost', error: String(err) }, 'completeTaskList');
        // Ignore errors on completion
      }
    }
  }

  /**
   * Serialize a bump operation through the queue (mutex pattern).
   * Ensures only one bump runs at a time to prevent race conditions.
   *
   * The key insight: we IMMEDIATELY update bumpQueue before awaiting,
   * so any concurrent call sees the new queue value and waits for us.
   */
  private async withBumpQueue<T>(fn: () => Promise<T>): Promise<T> {
    // Capture the current queue (what we need to wait for)
    const prevQueue = this.bumpQueue;

    // IMMEDIATELY create our lock and set it as the new queue
    // This ensures any concurrent call will wait for us
    let releaseLock: () => void;
    this.bumpQueue = new Promise(resolve => {
      releaseLock = resolve;
    });

    // Wait for previous operation to complete
    await prevQueue;

    // Now it's our turn - execute the function
    try {
      return await fn();
    } finally {
      // Release our lock so next operation can proceed
      releaseLock!();
    }
  }

  /**
   * Bump task list to bottom of thread.
   * Returns the old post ID for reuse, or null if no task list.
   *
   * This method is serialized through bumpQueue to prevent race conditions
   * when called simultaneously with bumpAndGetOldPost. If another bump
   * completes first, this becomes a no-op.
   */
  async bumpToBottom(ctx: ExecutorContext): Promise<string | null> {
    // Capture the post we intend to bump BEFORE queueing
    const targetPostId = this.state.tasksPostId;
    if (!targetPostId || !this.state.lastTasksContent || this.state.tasksCompleted) {
      return null;
    }

    return this.withBumpQueue(async () => {
      // Check if another bump already happened (postId changed)
      if (this.state.tasksPostId !== targetPostId) {
        ctx.logger.debug(`bumpToBottom skipped: another bump already happened`);
        return null;
      }
      return this.doBumpToBottom(ctx);
    });
  }

  /**
   * Internal implementation of bumpToBottom (not serialized).
   */
  private async doBumpToBottom(ctx: ExecutorContext): Promise<string | null> {
    if (!this.state.tasksPostId || !this.state.lastTasksContent || this.state.tasksCompleted) {
      return null;
    }

    const oldPostId = this.state.tasksPostId;

    ctx.logger.debug(`Bumping tasks to bottom, old post ${oldPostId.substring(0, 8)}`);

    // Remove toggle emoji and unpin old post
    try {
      await ctx.platform.removeReaction(oldPostId, MINIMIZE_TOGGLE_EMOJIS[0]);
    } catch {
      // Ignore
    }
    await ctx.platform.unpinPost(oldPostId).catch(() => {});

    // Delete old post - if this fails, don't create new post to prevent duplicates
    try {
      await ctx.platform.deletePost(oldPostId);
      ctx.threadLogger?.logExecutor('task_list', 'delete', oldPostId, { reason: 'bump_to_bottom' }, 'bumpToBottom');
    } catch (deleteErr) {
      ctx.logger.warn(`Failed to delete old task post ${oldPostId.substring(0, 8)} during bump: ${deleteErr}. Not creating new post to prevent duplicates.`);
      ctx.threadLogger?.logExecutor('task_list', 'error', oldPostId, { failedOp: 'deletePost', error: String(deleteErr) }, 'bumpToBottom');
      // Don't create new post - old one might still exist
      return null;
    }

    // Create new post at bottom
    const displayContent = this.state.tasksMinimized
      ? this.getMinimizedContent(this.state.lastTasksContent, ctx.formatter)
      : this.state.lastTasksContent;

    const post = await ctx.createInteractivePost(
      displayContent,
      [MINIMIZE_TOGGLE_EMOJIS[0]],
      { type: 'task_list', interactionType: 'toggle_minimize' }
    );

    this.state.tasksPostId = post.id;

    // Pin new post
    await ctx.platform.pinPost(post.id).catch(() => {});

    ctx.logger.debug(`Created new task post ${formatShortId(post.id)}`);
    ctx.threadLogger?.logExecutor('task_list', 'bump', post.id, { oldPostId }, 'bumpToBottom');

    return oldPostId;
  }

  /**
   * Toggle minimized state.
   * Public method for external toggle (e.g., from reaction handling).
   */
  async toggleMinimize(ctx: ExecutorContext): Promise<void> {
    if (!this.state.tasksPostId || !this.state.lastTasksContent) {
      return;
    }

    this.state.tasksMinimized = !this.state.tasksMinimized;

    const displayContent = this.state.tasksMinimized
      ? this.getMinimizedContent(this.state.lastTasksContent, ctx.formatter)
      : this.state.lastTasksContent;

    try {
      await ctx.platform.updatePost(this.state.tasksPostId, displayContent);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Handle a reaction event on a post.
   * Returns true if the reaction was handled, false otherwise.
   */
  async handleReaction(
    postId: string,
    emoji: string,
    action: 'added' | 'removed',
    ctx: ExecutorContext
  ): Promise<boolean> {
    ctx.logger.debug(`TaskListExecutor.handleReaction: postId=${postId.substring(0, 8)}, emoji=${emoji}, action=${action}, tasksPostId=${this.state.tasksPostId?.substring(0, 8) ?? 'none'}`);

    // Check if this reaction is on the tasks post
    if (postId !== this.state.tasksPostId) {
      ctx.logger.debug(`TaskListExecutor: postId does not match tasksPostId, ignoring`);
      return false;
    }

    // Check if this is the minimize toggle emoji
    if (!isMinimizeToggleEmoji(emoji)) {
      ctx.logger.debug(`TaskListExecutor: emoji ${emoji} is not minimize toggle, ignoring`);
      return false;
    }

    // Only toggle on 'added' reactions (ignore removals)
    if (action === 'added') {
      ctx.logger.debug(`TaskListExecutor: toggling minimize state`);
      await this.toggleMinimize(ctx);
      ctx.logger.debug(`TaskListExecutor: toggle complete, isMinimized=${this.state.tasksMinimized}`);
    } else {
      ctx.logger.debug(`TaskListExecutor: ignoring 'removed' reaction for minimize toggle`);
    }

    return true;
  }

  /**
   * Bump task list and return old post ID for content reuse.
   * Used by content executor to avoid creating extra posts.
   *
   * This method is serialized through bumpQueue to prevent race conditions
   * when called simultaneously with bumpToBottom. If another bump completes
   * first, this becomes a no-op (returns null).
   */
  async bumpAndGetOldPost(
    ctx: ExecutorContext,
    newContent: string
  ): Promise<string | null> {
    // Capture the post we intend to bump BEFORE queueing
    const targetPostId = this.state.tasksPostId;
    if (!this.hasActiveTasks() || !targetPostId) {
      return null;
    }

    return this.withBumpQueue(async () => {
      // Check if another bump already happened (postId changed)
      if (this.state.tasksPostId !== targetPostId) {
        ctx.logger.debug(`bumpAndGetOldPost skipped: another bump already happened`);
        return null;
      }
      return this.doBumpAndGetOldPost(ctx, newContent);
    });
  }

  /**
   * Internal implementation of bumpAndGetOldPost (not serialized).
   */
  private async doBumpAndGetOldPost(
    ctx: ExecutorContext,
    newContent: string
  ): Promise<string | null> {
    if (!this.hasActiveTasks() || !this.state.tasksPostId) {
      return null;
    }

    const oldPostId = this.state.tasksPostId;

    ctx.logger.debug(`Repurposing task post ${oldPostId.substring(0, 8)} for content`);

    // Remove toggle emoji
    try {
      await ctx.platform.removeReaction(oldPostId, MINIMIZE_TOGGLE_EMOJIS[0]);
    } catch {
      // Ignore
    }
    await ctx.platform.unpinPost(oldPostId).catch(() => {});

    // Try to update old post with new content
    let repurposedPostId: string | null = null;
    let shouldCreateNewTaskPost = true;
    try {
      await ctx.platform.updatePost(oldPostId, newContent);
      repurposedPostId = oldPostId;
      this.registerPost(oldPostId, { type: 'content' });
      ctx.threadLogger?.logExecutor('task_list', 'update', oldPostId, { action: 'repurposed_for_content' }, 'bumpAndGetOldPost');
    } catch (err) {
      ctx.logger.debug(`Could not repurpose task post: ${err}`);
      ctx.threadLogger?.logExecutor('task_list', 'error', oldPostId, { failedOp: 'updatePost', error: String(err), context: 'repurpose_failed' }, 'bumpAndGetOldPost');
      // Delete the old post to avoid orphaned task list visible to users
      try {
        await ctx.platform.deletePost(oldPostId);
        ctx.threadLogger?.logExecutor('task_list', 'delete', oldPostId, { reason: 'repurpose_failed_recovery' }, 'bumpAndGetOldPost');
      } catch (deleteErr) {
        // Delete also failed - DON'T create new task post to prevent duplicates!
        ctx.logger.warn(`Failed to delete old task post ${oldPostId.substring(0, 8)} during bump: ${deleteErr}. Not creating new task post to prevent duplicates.`);
        ctx.threadLogger?.logExecutor('task_list', 'error', oldPostId, { failedOp: 'deletePost', error: String(deleteErr), context: 'delete_after_repurpose_failed' }, 'bumpAndGetOldPost');
        shouldCreateNewTaskPost = false;
        this.state.tasksPostId = null;
      }
      // Will return null - caller should create new content post
    }

    // Create new task post at bottom (only if delete succeeded or repurpose succeeded)
    if (shouldCreateNewTaskPost && this.state.lastTasksContent) {
      const displayContent = this.state.tasksMinimized
        ? this.getMinimizedContent(this.state.lastTasksContent, ctx.formatter)
        : this.state.lastTasksContent;

      const post = await ctx.createInteractivePost(
        displayContent,
        [MINIMIZE_TOGGLE_EMOJIS[0]],
        { type: 'task_list', interactionType: 'toggle_minimize' }
      );

      this.state.tasksPostId = post.id;
      await ctx.platform.pinPost(post.id).catch(() => {});

      ctx.logger.debug(`Created new task post ${formatShortId(post.id)}`);
      ctx.threadLogger?.logExecutor('task_list', 'bump', post.id, { oldPostId }, 'bumpAndGetOldPost');
    } else if (!shouldCreateNewTaskPost) {
      // Already set tasksPostId to null above
    } else {
      this.state.tasksPostId = null;
    }

    return repurposedPostId;
  }

  /**
   * Create a new task list post.
   */
  private async createTaskPost(content: string, ctx: ExecutorContext): Promise<void> {

    const post = await ctx.createInteractivePost(
      content,
      [MINIMIZE_TOGGLE_EMOJIS[0]],
      { type: 'task_list', interactionType: 'toggle_minimize' }
    );

    this.state.tasksPostId = post.id;

    // Pin task list
    await ctx.platform.pinPost(post.id).catch(() => {});

    ctx.logger.debug(`Created task post ${formatShortId(post.id)}`);
    ctx.threadLogger?.logExecutor('task_list', 'create', post.id, undefined, 'createTaskPost');
  }

  /**
   * Format task list for display.
   */
  private formatTaskList(tasks: TaskItem[], formatter: PlatformFormatter): string {
    const completed = tasks.filter(t => t.status === 'completed').length;
    const total = tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const lines: string[] = [
      `${formatter.formatHorizontalRule()}`,
      `📋 ${formatter.formatBold('Tasks')} (${completed}/${total} · ${pct}%)`,
      '',
    ];

    for (const task of tasks) {
      let icon: string;
      let taskText: string;

      switch (task.status) {
        case 'completed':
          icon = '✅';
          taskText = formatter.formatStrikethrough(task.content);
          break;
        case 'in_progress':
          icon = '🔄';
          taskText = formatter.formatBold(task.activeForm || task.content);
          if (this.state.inProgressTaskStart) {
            const elapsed = Math.round((Date.now() - this.state.inProgressTaskStart) / 1000);
            taskText += ` (${elapsed}s)`;
          }
          break;
        default:
          icon = '⬜';
          taskText = task.content;
      }

      lines.push(`${icon} ${taskText}`);
    }

    return lines.join('\n');
  }

  /**
   * Get minimized content from full content.
   */
  private getMinimizedContent(fullContent: string, formatter: PlatformFormatter): string {
    // Parse progress from content
    const progressMatch = fullContent.match(/\((\d+)\/(\d+) · (\d+)%\)/);
    const completed = progressMatch ? parseInt(progressMatch[1], 10) : 0;
    const total = progressMatch ? parseInt(progressMatch[2], 10) : 0;
    const pct = progressMatch ? parseInt(progressMatch[3], 10) : 0;

    // Find current in-progress task
    const inProgressMatch = fullContent.match(/🔄 \*{1,2}([^*]+)\*{1,2}(?:\s*\((\d+)s\))?/);
    let currentTaskText = '';
    if (inProgressMatch) {
      const taskName = inProgressMatch[1];
      const elapsed = inProgressMatch[2] ? ` (${inProgressMatch[2]}s)` : '';
      currentTaskText = ` · 🔄 ${taskName}${elapsed}`;
    }

    return `${formatter.formatHorizontalRule()}\n📋 ${formatter.formatBold('Tasks')} (${completed}/${total} · ${pct}%)${currentTaskText} 🔽`;
  }
}
