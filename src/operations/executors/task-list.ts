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
import { MINIMIZE_TOGGLE_EMOJIS } from '../../utils/emoji.js';
import type { TaskListOp, TaskItem } from '../types.js';
import type { ExecutorContext, TaskListState, RegisterPostCallback, UpdateLastMessageCallback } from './types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('task-executor');

// ---------------------------------------------------------------------------
// Task List Executor
// ---------------------------------------------------------------------------

/**
 * Executor for task list operations.
 */
export class TaskListExecutor {
  private state: TaskListState;
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;

  constructor(options: {
    registerPost: RegisterPostCallback;
    updateLastMessage: UpdateLastMessageCallback;
  }) {
    this.state = {
      tasksPostId: null,
      lastTasksContent: null,
      tasksCompleted: false,
      tasksMinimized: false,
      inProgressTaskStart: null,
    };
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
  }

  /**
   * Get the current state (for inspection/testing).
   */
  getState(): Readonly<TaskListState> {
    return { ...this.state };
  }

  /**
   * Reset state (for session restart).
   */
  reset(): void {
    this.state = {
      tasksPostId: null,
      lastTasksContent: null,
      tasksCompleted: false,
      tasksMinimized: false,
      inProgressTaskStart: null,
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
    const logger = log.forSession(ctx.sessionId);

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
        logger.warn(`Unknown task list action: ${op.action}`);
    }
  }

  /**
   * Update the task list.
   */
  private async updateTaskList(tasks: TaskItem[], ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);
    const formatter = ctx.platform.getFormatter();

    // Track in-progress task timing
    const inProgressTask = tasks.find(t => t.status === 'in_progress');
    if (inProgressTask && !this.state.inProgressTaskStart) {
      this.state.inProgressTaskStart = Date.now();
    } else if (!inProgressTask) {
      this.state.inProgressTaskStart = null;
    }

    // Format task list content
    const content = this.formatTaskList(tasks, formatter);
    this.state.lastTasksContent = content;
    this.state.tasksCompleted = false;

    // Get display content (minimized or full)
    const displayContent = this.state.tasksMinimized
      ? this.getMinimizedContent(content, formatter)
      : content;

    if (this.state.tasksPostId) {
      // Update existing post
      try {
        await ctx.platform.updatePost(this.state.tasksPostId, displayContent);
      } catch (err) {
        logger.debug(`Failed to update task post, creating new: ${err}`);
        await this.createTaskPost(displayContent, ctx);
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
    const formatter = ctx.platform.getFormatter();

    // Format final task list
    const content = this.formatTaskList(tasks, formatter);
    this.state.lastTasksContent = content;
    this.state.tasksCompleted = true;
    this.state.inProgressTaskStart = null;

    // Always show full list when completed
    if (this.state.tasksPostId) {
      try {
        await ctx.platform.updatePost(this.state.tasksPostId, content);
        // Unpin completed task list
        await ctx.platform.unpinPost(this.state.tasksPostId).catch(() => {});
      } catch {
        // Ignore errors on completion
      }
    }
  }

  /**
   * Bump task list to bottom of thread.
   * Returns the old post ID for reuse, or null if no task list.
   */
  async bumpToBottom(ctx: ExecutorContext): Promise<string | null> {
    const logger = log.forSession(ctx.sessionId);

    if (!this.state.tasksPostId || !this.state.lastTasksContent || this.state.tasksCompleted) {
      return null;
    }

    const oldPostId = this.state.tasksPostId;
    const formatter = ctx.platform.getFormatter();

    logger.debug(`Bumping tasks to bottom, old post ${oldPostId.substring(0, 8)}`);

    // Remove toggle emoji and unpin old post
    try {
      await ctx.platform.removeReaction(oldPostId, MINIMIZE_TOGGLE_EMOJIS[0]);
    } catch {
      // Ignore
    }
    await ctx.platform.unpinPost(oldPostId).catch(() => {});

    // Delete old post
    await ctx.platform.deletePost(oldPostId).catch(() => {});

    // Create new post at bottom
    const displayContent = this.state.tasksMinimized
      ? this.getMinimizedContent(this.state.lastTasksContent, formatter)
      : this.state.lastTasksContent;

    const post = await ctx.platform.createInteractivePost(
      displayContent,
      [MINIMIZE_TOGGLE_EMOJIS[0]],
      ctx.threadId
    );

    this.state.tasksPostId = post.id;
    this.registerPost(post.id, { type: 'task_list', interactionType: 'toggle_minimize' });
    this.updateLastMessage(post);

    // Pin new post
    await ctx.platform.pinPost(post.id).catch(() => {});

    logger.debug(`Created new task post ${post.id.substring(0, 8)}`);

    return oldPostId;
  }

  /**
   * Toggle minimized state.
   */
  async toggleMinimize(ctx: ExecutorContext): Promise<void> {
    if (!this.state.tasksPostId || !this.state.lastTasksContent) {
      return;
    }

    const formatter = ctx.platform.getFormatter();
    this.state.tasksMinimized = !this.state.tasksMinimized;

    const displayContent = this.state.tasksMinimized
      ? this.getMinimizedContent(this.state.lastTasksContent, formatter)
      : this.state.lastTasksContent;

    try {
      await ctx.platform.updatePost(this.state.tasksPostId, displayContent);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Bump task list and return old post ID for content reuse.
   * Used by content executor to avoid creating extra posts.
   */
  async bumpAndGetOldPost(
    ctx: ExecutorContext,
    newContent: string
  ): Promise<string | null> {
    const logger = log.forSession(ctx.sessionId);

    if (!this.hasActiveTasks() || !this.state.tasksPostId) {
      return null;
    }

    const oldPostId = this.state.tasksPostId;
    const formatter = ctx.platform.getFormatter();

    logger.debug(`Repurposing task post ${oldPostId.substring(0, 8)} for content`);

    // Remove toggle emoji
    try {
      await ctx.platform.removeReaction(oldPostId, MINIMIZE_TOGGLE_EMOJIS[0]);
    } catch {
      // Ignore
    }
    await ctx.platform.unpinPost(oldPostId).catch(() => {});

    // Try to update old post with new content
    let repurposedPostId: string | null = null;
    try {
      await ctx.platform.updatePost(oldPostId, newContent);
      repurposedPostId = oldPostId;
      this.registerPost(oldPostId, { type: 'content' });
    } catch (err) {
      logger.debug(`Could not repurpose task post: ${err}`);
      // Will return null - caller should create new post
    }

    // Create new task post at bottom
    if (this.state.lastTasksContent) {
      const displayContent = this.state.tasksMinimized
        ? this.getMinimizedContent(this.state.lastTasksContent, formatter)
        : this.state.lastTasksContent;

      const post = await ctx.platform.createInteractivePost(
        displayContent,
        [MINIMIZE_TOGGLE_EMOJIS[0]],
        ctx.threadId
      );

      this.state.tasksPostId = post.id;
      this.registerPost(post.id, { type: 'task_list', interactionType: 'toggle_minimize' });
      this.updateLastMessage(post);
      await ctx.platform.pinPost(post.id).catch(() => {});

      logger.debug(`Created new task post ${post.id.substring(0, 8)}`);
    } else {
      this.state.tasksPostId = null;
    }

    return repurposedPostId;
  }

  /**
   * Create a new task list post.
   */
  private async createTaskPost(content: string, ctx: ExecutorContext): Promise<void> {
    const logger = log.forSession(ctx.sessionId);

    const post = await ctx.platform.createInteractivePost(
      content,
      [MINIMIZE_TOGGLE_EMOJIS[0]],
      ctx.threadId
    );

    this.state.tasksPostId = post.id;
    this.registerPost(post.id, { type: 'task_list', interactionType: 'toggle_minimize' });
    this.updateLastMessage(post);

    // Pin task list
    await ctx.platform.pinPost(post.id).catch(() => {});

    logger.debug(`Created task post ${post.id.substring(0, 8)}`);
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
