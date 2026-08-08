/**
 * Task tracker for the TaskCreate/TaskUpdate tool family.
 *
 * Modern Claude CLI versions (verified against 2.1.223) track tasks with
 * incremental TaskCreate/TaskUpdate calls instead of TodoWrite's
 * whole-list-per-call shape. TaskCreate carries no task id in its input —
 * the id is only revealed by the tool result ("Task #3 created successfully:
 * ..."), which arrives later inside a `user` event. TaskUpdate then refers to
 * tasks by that id.
 *
 * This tracker accumulates the incremental calls into a full task list so the
 * existing TaskListOp / task-list executor pipeline (built for TodoWrite's
 * full-list semantics) keeps working unchanged. One instance lives per
 * session (owned by MessageManager, like `toolStartTimes`), because task
 * state spans many events.
 */

import type { TaskItem } from './types.js';

/** A single tracked task. */
export interface TrackedTask {
  /**
   * Real task id (e.g. "3") once known. Unset between the TaskCreate call
   * and its tool result.
   */
  taskId?: string;
  subject: string;
  activeForm?: string;
  status: TaskItem['status'];
  /**
   * True for tasks the tracker never saw created — synthesized from a
   * TaskUpdate for an unknown id (task created before a resume, etc.).
   * Placeholder-only sets must not count as "all completed": after a bot
   * restart the CLI session may hold many open tasks the fresh tracker
   * doesn't know about, and one completed placeholder would otherwise
   * delete the restored task-list display and signal full completion.
   */
  isPlaceholder?: boolean;
}

/**
 * Serialized task shape stored in PersistedSession.taskTrackerState. Only
 * tasks with a resolved id are restorable — an in-flight TaskCreate's tool
 * result will never arrive after a restart, and without an id the task could
 * never be updated again anyway.
 */
export interface PersistedTrackedTask {
  taskId: string;
  subject: string;
  activeForm?: string;
  status: TaskItem['status'];
  isPlaceholder?: boolean;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

/** Matches TaskCreate tool results like "Task #3 created successfully: ...". */
const CREATED_RESULT_RE = /Task #(\S+) created/;

export class TaskTracker {
  private tasks: TrackedTask[] = [];
  /** TaskCreate tool_use_id → task awaiting its id from the tool result. */
  private pendingCreates = new Map<string, TrackedTask>();
  /**
   * Count of non-error TaskCreate results that did NOT carry the expected
   * "Task #N created" text. A steady stream of these means the CLI reworded
   * the result — the tracker is then silently blind, and the owner (see
   * MessageManager) should log a warning.
   */
  private unmatchedCreateResults = 0;

  /** Record a TaskCreate call. The task id arrives later via the tool result. */
  create(toolUseId: string, input: Record<string, unknown>): void {
    const task: TrackedTask = {
      subject: typeof input.subject === 'string' ? input.subject : 'Task',
      activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
      status: 'pending',
    };
    this.tasks.push(task);
    if (toolUseId) {
      this.pendingCreates.set(toolUseId, task);
    }
  }

  /** Whether this tool_use_id belongs to a TaskCreate still awaiting its result. */
  hasPendingCreate(toolUseId: string): boolean {
    return this.pendingCreates.has(toolUseId);
  }

  /**
   * Resolve a pending TaskCreate's real id from its tool result content.
   * Safe to call with any tool result — non-TaskCreate ids are ignored.
   *
   * A create whose result is an error or doesn't carry the expected
   * "Task #N created" text is REMOVED from the list: keeping it would leave a
   * permanent ghost row that can never be updated or completed (updates go by
   * taskId), which would also pin `allCompleted` at false forever. Removal is
   * also the safe response to the CLI rewording the result text (tracked via
   * `consumeUnmatchedCreateResultFlag` so the owner can log it).
   *
   * Returns 'resolved' when the id was attached, 'merged' when resolving also
   * absorbed a placeholder row (display should refresh), 'removed' when the
   * task was dropped (display should refresh), 'ignored' otherwise.
   */
  resolveCreatedId(
    toolUseId: string,
    resultContent: string,
    isError = false
  ): 'resolved' | 'merged' | 'removed' | 'ignored' {
    const task = this.pendingCreates.get(toolUseId);
    if (!task) return 'ignored';
    // The create either resolved or failed; stop waiting on it either way.
    this.pendingCreates.delete(toolUseId);
    const match = isError ? null : CREATED_RESULT_RE.exec(resultContent);
    if (!match) {
      if (!isError) this.unmatchedCreateResults++;
      this.tasks = this.tasks.filter(t => t !== task);
      return 'removed';
    }
    // If an update already created a placeholder for this id, merge: adopt
    // the placeholder's status (and any rename it carried — an update's
    // subject is newer information than the create's), then drop it — two
    // rows sharing one id would make one unreachable.
    const placeholder = this.tasks.find(t => t !== task && t.taskId === match[1]);
    if (placeholder) {
      task.status = placeholder.status;
      if (placeholder.subject !== `Task #${match[1]}`) task.subject = placeholder.subject;
      if (placeholder.activeForm && !task.activeForm) task.activeForm = placeholder.activeForm;
      this.tasks = this.tasks.filter(t => t !== placeholder);
    }
    task.taskId = match[1];
    return placeholder ? 'merged' : 'resolved';
  }

  /**
   * True once a non-error TaskCreate result failed to match the expected
   * wording — a signal the CLI's result text drifted. Reading resets the flag
   * so the owner can warn once per occurrence batch.
   */
  consumeUnmatchedCreateResultFlag(): boolean {
    if (this.unmatchedCreateResults === 0) return false;
    this.unmatchedCreateResults = 0;
    return true;
  }

  /**
   * Apply a TaskUpdate call. Unknown task ids (e.g. tasks created before a
   * resume, or by a subagent) get a placeholder entry so status is still
   * visible. Returns true when the update changed anything.
   */
  update(input: Record<string, unknown>): boolean {
    // The SDK schema types taskId as a string, but tolerate a numeric id —
    // silently no-oping on `taskId: 1` would freeze the displayed list.
    const taskId =
      typeof input.taskId === 'string'
        ? input.taskId
        : typeof input.taskId === 'number'
          ? String(input.taskId)
          : undefined;
    if (!taskId) return false;

    let task = this.tasks.find(t => t.taskId === taskId);
    const status = typeof input.status === 'string' ? input.status : undefined;

    if (status === 'deleted') {
      if (!task) return false;
      this.tasks = this.tasks.filter(t => t !== task);
      return true;
    }

    if (!task) {
      task = { taskId, subject: `Task #${taskId}`, status: 'pending', isPlaceholder: true };
      this.tasks.push(task);
    }

    if (typeof input.subject === 'string') task.subject = input.subject;
    if (typeof input.activeForm === 'string') task.activeForm = input.activeForm;
    if (status === 'pending' || status === 'in_progress' || status === 'completed') {
      task.status = status;
    }
    return true;
  }

  /** Current tasks in TaskItem shape for TaskListOp. */
  toTaskItems(): TaskItem[] {
    return this.tasks.map(t => ({
      content: t.subject,
      status: t.status,
      activeForm: t.activeForm ?? t.subject,
    }));
  }

  get isEmpty(): boolean {
    return this.tasks.length === 0;
  }

  /**
   * All tasks completed — and at least one of them is a task this tracker
   * actually saw created. A set consisting only of placeholders (updates to
   * ids from before a bot restart) must not signal completion: the CLI
   * session may hold open tasks the tracker has never seen, and a 'complete'
   * action would delete the restored task-list display.
   */
  get allCompleted(): boolean {
    return (
      this.tasks.length > 0 &&
      this.tasks.every(t => t.status === 'completed') &&
      this.tasks.some(t => !t.isPlaceholder)
    );
  }

  clear(): void {
    this.tasks = [];
    this.pendingCreates.clear();
    this.unmatchedCreateResults = 0;
  }

  /**
   * Snapshot for persistence: every task with a resolved id (placeholders
   * keep their flag so a restored set can't fake completion). Returns
   * undefined when nothing is restorable, keeping the persisted record lean.
   */
  serialize(): PersistedTrackedTask[] | undefined {
    const restorable = this.tasks.filter(
      (t): t is TrackedTask & { taskId: string } => Boolean(t.taskId)
    );
    if (restorable.length === 0) return undefined;
    return restorable.map(t => {
      const out: PersistedTrackedTask = {
        taskId: t.taskId,
        subject: t.subject,
        status: t.status,
      };
      if (t.activeForm) out.activeForm = t.activeForm;
      if (t.isPlaceholder) out.isPlaceholder = true;
      return out;
    });
  }

  /**
   * Rebuild state from a persisted snapshot (session resume). Replaces the
   * current task set. Defensive against malformed persisted data — a
   * non-array value resets to empty, null/primitive rows and rows without a
   * usable id are dropped, unknown statuses normalize to pending — per the
   * repo's backward-compatibility rules for persisted state. A throw here
   * would abort the entire session resume, so nothing in this method may
   * throw on corrupt input.
   */
  restore(state: PersistedTrackedTask[]): void {
    if (!Array.isArray(state)) {
      this.tasks = [];
      this.pendingCreates.clear();
      return;
    }
    this.tasks = state
      .filter((t): t is PersistedTrackedTask =>
        t !== null && typeof t === 'object' &&
        typeof t.taskId === 'string' && t.taskId.length > 0 && typeof t.subject === 'string')
      .map(t => ({
        taskId: t.taskId,
        subject: t.subject || `Task #${t.taskId}`,
        activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
        status: (VALID_STATUSES.has(t.status) ? t.status : 'pending') as TaskItem['status'],
        isPlaceholder: t.isPlaceholder === true ? true : undefined,
      }));
    this.pendingCreates.clear();
  }
}
