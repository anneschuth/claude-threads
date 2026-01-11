# Platform Abstraction Layer Refactor Plan

## Executive Summary

This document proposes a comprehensive refactor of how Claude Code output is translated into chat platform messages. The current implementation has grown organically and has several pain points around message streaming, task list management, and platform-specific formatting. This plan designs a clean architecture from scratch, then maps a migration path from the current code.

---

## Part 1: Current State Analysis

### What Works Well

1. **Platform Client Interface** (`src/platform/client.ts`)
   - Clean abstraction over Mattermost/Slack differences
   - Good interface for `createPost`, `updatePost`, `deletePost`, reactions
   - Type normalization is solid

2. **Platform Formatter** (`src/platform/formatter.ts`)
   - Handles markdown dialect differences (Mattermost MD vs Slack mrkdwn)
   - Tables, code blocks, formatting all abstracted

3. **Session Module Structure** (`src/session/`)
   - Good separation: lifecycle, events, reactions, commands, streaming
   - Unified `SessionContext` interface

### Pain Points

1. **Message Streaming Complexity** (`streaming.ts` - 900+ lines)
   - Task list "stickiness" requires complex locking mechanism
   - Logical breakpoint detection scattered throughout
   - Post repurposing logic is fragile
   - Race conditions between content appending and flushing

2. **Tool Formatting** (`tool-formatter.ts`)
   - Two code paths: `formatToolUse()` vs `formatToolForPermission()`
   - Tool-specific logic scattered (Chrome, MCP, standard tools)
   - No plugin system for new tools

3. **Event Processing** (`events.ts` - 700+ lines)
   - Content assembly interleaved with command detection
   - Multiple pending state types with different patterns
   - Post registration scattered throughout

4. **No Clear Data Model**
   - Claude events go directly into `pendingContent` string
   - No intermediate representation of "what to render"
   - Hard to reason about message lifecycle

---

## Part 2: Proposed Architecture

### Core Concept: Message Operations

Instead of directly manipulating strings and posts, introduce a **Message Operation** model that represents discrete, semantic actions to take on the chat platform.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NEW ARCHITECTURE                                   │
│                                                                             │
│  ┌────────────┐     ┌──────────────┐     ┌─────────────────┐                │
│  │ ClaudeEvent│     │  Operation   │     │   Operation     │                │
│  │  (from CLI)│ ──▶ │  Transformer │ ──▶ │     Queue       │                │
│  └────────────┘     └──────────────┘     └───────┬─────────┘                │
│                                                  │                          │
│                     ┌────────────────────────────┘                          │
│                     ▼                                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      Operation Executor                               │   │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐             │   │
│  │  │ ContentOp     │  │ TaskListOp    │  │ InteractiveOp │             │   │
│  │  │ Executor      │  │ Executor      │  │ Executor      │             │   │
│  │  └───────────────┘  └───────────────┘  └───────────────┘             │   │
│  └──────────────────────────────────────┬───────────────────────────────┘   │
│                                         │                                   │
│                                         ▼                                   │
│                              ┌──────────────────┐                           │
│                              │ PlatformClient   │                           │
│                              │ (Mattermost/     │                           │
│                              │  Slack)          │                           │
│                              └──────────────────┘                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Layer 1: Operation Types

Define discrete operations that can be performed on a chat thread:

```typescript
// src/operations/types.ts

/**
 * Base interface for all message operations
 */
interface BaseOperation {
  type: string;
  timestamp: number;
  sessionId: string;
}

/**
 * Append content to the current streaming message
 */
interface AppendContentOp extends BaseOperation {
  type: 'append_content';
  content: string;
  contentType: 'text' | 'tool_use' | 'tool_result' | 'code_block';
  metadata?: {
    toolName?: string;
    toolUseId?: string;
    language?: string;
  };
}

/**
 * Flush current content to a new or existing post
 */
interface FlushContentOp extends BaseOperation {
  type: 'flush_content';
  reason: 'timer' | 'break_point' | 'interactive' | 'end_turn';
}

/**
 * Update or create the task list
 */
interface TaskListOp extends BaseOperation {
  type: 'task_list';
  action: 'create' | 'update' | 'bump' | 'minimize' | 'expand';
  content?: string;  // Formatted task list content
  progress?: { completed: number; total: number; percentage: number };
}

/**
 * Create an interactive post (questions, approvals)
 */
interface InteractiveOp extends BaseOperation {
  type: 'interactive';
  interactionType: 'question' | 'plan_approval' | 'message_approval' | 'permission';
  content: string;
  options: Array<{ emoji: string; label: string; value: string }>;
  toolUseId?: string;
}

/**
 * Post a system message (info, warning, error)
 */
interface SystemMessageOp extends BaseOperation {
  type: 'system_message';
  level: 'info' | 'warning' | 'error' | 'success';
  content: string;
  ephemeral?: boolean;  // If true, can be deleted later
}

/**
 * Update the session header/sticky message
 */
interface StatusUpdateOp extends BaseOperation {
  type: 'status_update';
  content: string;
}

/**
 * Subagent status update
 */
interface SubagentOp extends BaseOperation {
  type: 'subagent';
  action: 'start' | 'update' | 'complete' | 'minimize' | 'expand';
  toolUseId: string;
  description: string;
  subagentType: string;
  elapsedMs?: number;
}

type MessageOperation =
  | AppendContentOp
  | FlushContentOp
  | TaskListOp
  | InteractiveOp
  | SystemMessageOp
  | StatusUpdateOp
  | SubagentOp;
```

### Layer 2: Event Transformer

Transform Claude CLI events into operations. This is a pure function with no side effects.

```typescript
// src/operations/transformer.ts

interface TransformContext {
  session: SessionState;  // Read-only session state
  formatter: PlatformFormatter;
  worktreePath?: string;
}

/**
 * Transform a Claude event into zero or more operations
 */
function transformEvent(
  event: ClaudeEvent,
  context: TransformContext
): MessageOperation[] {
  switch (event.type) {
    case 'assistant':
      return transformAssistantEvent(event, context);
    case 'tool_use':
      return transformToolUseEvent(event, context);
    case 'tool_result':
      return transformToolResultEvent(event, context);
    case 'result':
      return transformResultEvent(event, context);
    // ... etc
  }
}

// Example: assistant event produces AppendContentOp
function transformAssistantEvent(
  event: AssistantEvent,
  context: TransformContext
): MessageOperation[] {
  const ops: MessageOperation[] = [];

  if (event.message?.content) {
    const text = extractText(event.message.content);
    if (text) {
      ops.push({
        type: 'append_content',
        timestamp: Date.now(),
        sessionId: context.session.sessionId,
        content: text,
        contentType: 'text',
      });
    }
  }

  return ops;
}
```

**Benefits:**
- Pure functions are easy to test
- Clear mapping from Claude events to operations
- Tool formatting logic consolidated here
- No direct mutation of session state

### Layer 3: Operation Queue

Queue and batch operations before execution:

```typescript
// src/operations/queue.ts

class OperationQueue {
  private queue: MessageOperation[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private executor: OperationExecutor;

  constructor(executor: OperationExecutor) {
    this.executor = executor;
  }

  /**
   * Add operation to queue, maybe trigger flush
   */
  enqueue(op: MessageOperation): void {
    this.queue.push(op);

    // Some operations trigger immediate flush
    if (this.shouldFlushImmediately(op)) {
      this.flush();
      return;
    }

    // Otherwise, schedule a batched flush
    this.scheduleFlush();
  }

  /**
   * Flush all pending operations
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0) return;

    // Take all operations
    const ops = this.queue;
    this.queue = [];

    // Batch and execute
    const batched = this.batchOperations(ops);
    for (const batch of batched) {
      await this.executor.execute(batch);
    }
  }

  /**
   * Combine adjacent content operations, etc.
   */
  private batchOperations(ops: MessageOperation[]): MessageOperation[][] {
    // Group adjacent AppendContentOps
    // Keep TaskListOps separate
    // Keep InteractiveOps separate
    // ...
  }
}
```

**Benefits:**
- Batching reduces API calls
- Clear flush semantics
- Content operations coalesced automatically
- Interactive operations never batched (immediate)

### Layer 4: Operation Executors

Execute operations against the platform:

```typescript
// src/operations/executors/content.ts

class ContentExecutor {
  constructor(
    private platform: PlatformClient,
    private postTracker: PostTracker,
    private contentBreaker: ContentBreaker,
  ) {}

  /**
   * Execute a batch of content operations
   */
  async execute(
    ops: AppendContentOp[],
    sessionState: SessionState
  ): Promise<void> {
    // 1. Combine all content
    const combined = ops.map(op => op.content).join('');

    // 2. Format for platform
    const formatted = this.platform.getFormatter().formatMarkdown(combined);

    // 3. Break at logical points if needed
    const chunks = this.contentBreaker.break(formatted, {
      maxLength: this.platform.getMessageLimits().maxLength,
      preferredBreakPoints: ['heading', 'code_block', 'tool_result'],
    });

    // 4. Post each chunk
    for (const chunk of chunks) {
      if (sessionState.currentPostId && this.canUpdate(sessionState, chunk)) {
        await this.updatePost(sessionState, chunk);
      } else {
        await this.createPost(sessionState, chunk);
      }
    }
  }
}
```

```typescript
// src/operations/executors/task-list.ts

class TaskListExecutor {
  constructor(
    private platform: PlatformClient,
    private postTracker: PostTracker,
  ) {}

  /**
   * Execute task list operation
   */
  async execute(op: TaskListOp, sessionState: SessionState): Promise<void> {
    switch (op.action) {
      case 'create':
        await this.createTaskList(op, sessionState);
        break;
      case 'update':
        await this.updateTaskList(op, sessionState);
        break;
      case 'bump':
        await this.bumpTaskList(sessionState);
        break;
      case 'minimize':
      case 'expand':
        await this.toggleMinimize(op.action === 'minimize', sessionState);
        break;
    }
  }

  /**
   * Bump task list to bottom (delete + recreate)
   */
  private async bumpTaskList(sessionState: SessionState): Promise<void> {
    if (!sessionState.tasksPostId || !sessionState.lastTasksContent) return;

    // Delete old post
    await this.platform.deletePost(sessionState.tasksPostId);

    // Create new post at bottom
    const post = await this.platform.createPost(
      sessionState.threadId,
      sessionState.lastTasksContent
    );

    // Update state
    sessionState.tasksPostId = post.id;
    this.postTracker.register(post.id, sessionState.threadId);
  }
}
```

**Benefits:**
- Each executor handles one concern
- Clear responsibility boundaries
- Easy to test in isolation
- Platform-agnostic logic in executors

### Layer 5: Content Breaker

Dedicated module for breaking content at logical points:

```typescript
// src/operations/content-breaker.ts

interface BreakOptions {
  maxLength: number;
  preferredBreakPoints: ('heading' | 'code_block' | 'tool_result' | 'paragraph')[];
  minChunkSize?: number;
}

interface ContentBreaker {
  /**
   * Break content into chunks that respect logical boundaries
   */
  break(content: string, options: BreakOptions): string[];

  /**
   * Check if we're inside a code block at position
   */
  isInCodeBlock(content: string, position: number): boolean;

  /**
   * Find the best break point before maxLength
   */
  findBreakPoint(content: string, maxLength: number): number;
}

class DefaultContentBreaker implements ContentBreaker {
  break(content: string, options: BreakOptions): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > options.maxLength) {
      const breakPoint = this.findBreakPoint(remaining, options.maxLength);
      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint);
    }

    if (remaining) {
      chunks.push(remaining);
    }

    return chunks;
  }

  findBreakPoint(content: string, maxLength: number): number {
    // Try to break at heading
    const headingMatch = content.slice(0, maxLength).match(/\n(#{1,6} )/g);
    if (headingMatch) {
      const lastHeading = content.lastIndexOf(headingMatch[headingMatch.length - 1]);
      if (lastHeading > 500) return lastHeading;
    }

    // Try to break at code block boundary
    const codeBlockEnd = content.slice(0, maxLength).lastIndexOf('\n```\n');
    if (codeBlockEnd > 500) return codeBlockEnd + 5;

    // Try to break at paragraph
    const paragraphBreak = content.slice(0, maxLength).lastIndexOf('\n\n');
    if (paragraphBreak > 500) return paragraphBreak + 2;

    // Fall back to newline
    const lineBreak = content.slice(0, maxLength).lastIndexOf('\n');
    if (lineBreak > 0) return lineBreak + 1;

    // Hard break
    return maxLength;
  }
}
```

**Benefits:**
- Single responsibility: just content breaking
- Easy to unit test with various content patterns
- No coupling to streaming logic

### Layer 6: Post Tracker

Centralized tracking of posts for reaction routing:

```typescript
// src/operations/post-tracker.ts

interface PostInfo {
  postId: string;
  threadId: string;
  sessionId: string;
  type: 'content' | 'task_list' | 'interactive' | 'system' | 'subagent';
  createdAt: number;
  interactionType?: 'question' | 'plan_approval' | 'message_approval' | 'permission';
}

class PostTracker {
  private posts = new Map<string, PostInfo>();

  register(info: PostInfo): void {
    this.posts.set(info.postId, info);
  }

  unregister(postId: string): void {
    this.posts.delete(postId);
  }

  get(postId: string): PostInfo | undefined {
    return this.posts.get(postId);
  }

  getByThread(threadId: string): PostInfo[] {
    return Array.from(this.posts.values())
      .filter(p => p.threadId === threadId);
  }

  /**
   * Find the session that should handle a reaction to this post
   */
  findSessionForReaction(postId: string): string | undefined {
    return this.posts.get(postId)?.sessionId;
  }
}
```

**Benefits:**
- Single source of truth for post tracking
- Clear query interface
- Easy to debug (can dump all tracked posts)
- Reaction routing becomes trivial

### Layer 7: Tool Formatter Registry

Plugin system for tool formatting:

```typescript
// src/operations/tool-formatters/registry.ts

interface ToolFormatResult {
  display: string | null;  // For chat display (null = don't display)
  permission: string;      // For permission prompts
}

interface ToolFormatter {
  canFormat(toolName: string): boolean;
  format(toolName: string, input: unknown, options: FormatOptions): ToolFormatResult;
}

class ToolFormatterRegistry {
  private formatters: ToolFormatter[] = [];

  register(formatter: ToolFormatter): void {
    this.formatters.push(formatter);
  }

  format(toolName: string, input: unknown, options: FormatOptions): ToolFormatResult {
    for (const formatter of this.formatters) {
      if (formatter.canFormat(toolName)) {
        return formatter.format(toolName, input, options);
      }
    }
    return this.defaultFormat(toolName, input);
  }
}

// Individual tool formatters
class FileToolFormatter implements ToolFormatter {
  canFormat(toolName: string): boolean {
    return ['Read', 'Write', 'Edit'].includes(toolName);
  }

  format(toolName: string, input: unknown, options: FormatOptions): ToolFormatResult {
    // ... file-specific formatting
  }
}

class BashToolFormatter implements ToolFormatter { /* ... */ }
class ChromeToolFormatter implements ToolFormatter { /* ... */ }
class McpToolFormatter implements ToolFormatter { /* ... */ }
```

**Benefits:**
- Easy to add new tool formatters
- Single code path for all formatting
- Display and permission formatting in one place
- No hardcoded tool lists in event handler

---

## Part 3: State Management

### Simplified Session State

The new architecture reduces session state needed for message management:

```typescript
// src/session/state.ts

interface MessageState {
  // Current streaming post
  currentPostId: string | null;
  currentPostContent: string;

  // Task list
  tasksPostId: string | null;
  lastTasksContent: string | null;
  tasksMinimized: boolean;
  tasksCompleted: boolean;

  // Subagents
  activeSubagents: Map<string, SubagentState>;
}

interface InteractiveState {
  pendingApproval: PendingApproval | null;
  pendingQuestionSet: PendingQuestionSet | null;
  pendingMessageApproval: PendingMessageApproval | null;
  // ... other pending states stay the same
}

// Session now delegates message handling to MessageManager
interface Session {
  // Identity (unchanged)
  sessionId: string;
  threadId: string;
  platformId: string;
  // ...

  // NEW: Message state managed separately
  messageState: MessageState;
  interactiveState: InteractiveState;

  // NEW: References to managers
  messageManager: MessageManager;  // Handles operations
}
```

### Message Manager

Orchestrates the operation pipeline:

```typescript
// src/operations/message-manager.ts

class MessageManager {
  constructor(
    private transformer: EventTransformer,
    private queue: OperationQueue,
    private contentExecutor: ContentExecutor,
    private taskListExecutor: TaskListExecutor,
    private interactiveExecutor: InteractiveExecutor,
    private postTracker: PostTracker,
  ) {}

  /**
   * Handle a Claude event
   */
  async handleEvent(event: ClaudeEvent, session: Session): Promise<void> {
    // 1. Transform event to operations
    const ops = this.transformer.transform(event, {
      session: session,
      formatter: session.platform.getFormatter(),
      worktreePath: session.worktreeInfo?.worktreePath,
    });

    // 2. Enqueue operations
    for (const op of ops) {
      this.queue.enqueue(op);
    }
  }

  /**
   * Force flush all pending content
   */
  async flush(): Promise<void> {
    await this.queue.flush();
  }

  /**
   * Post a system message
   */
  async postSystemMessage(
    session: Session,
    level: 'info' | 'warning' | 'error' | 'success',
    content: string
  ): Promise<string> {
    // Direct execution, no queue
    return this.systemExecutor.execute({
      type: 'system_message',
      timestamp: Date.now(),
      sessionId: session.sessionId,
      level,
      content,
    }, session);
  }
}
```

---

## Part 4: Migration Plan

### Phase 1: Foundation (Low Risk) - PR #1

**Goal:** Extract core utilities without changing behavior. Each step is a separate commit.

#### Step 1.1: Extract ContentBreaker

**Create:** `src/operations/content-breaker.ts`

Extract these functions from `streaming.ts`:
- `getCodeBlockState()` (lines ~180-220)
- `findLogicalBreakpoint()` (lines ~230-290)
- `shouldFlushEarly()` (lines ~300-340)
- `endsAtBreakpoint()` (lines ~350-380)

```typescript
// src/operations/content-breaker.ts
export interface ContentBreaker {
  break(content: string, maxLength: number): string[];
  findBreakPoint(content: string, maxLength: number): number;
  isInCodeBlock(content: string, position: number): boolean;
}

export class DefaultContentBreaker implements ContentBreaker {
  // Move existing logic here unchanged
}
```

**Test file:** `src/operations/content-breaker.test.ts`
- Test code block detection (opening, closing, nested)
- Test heading breaks (h1-h6)
- Test tool result breaks (`---` markers)
- Test paragraph breaks
- Test edge cases: empty content, single line, exactly at limit

**Wire up:** Change `streaming.ts` to import and use `DefaultContentBreaker`

#### Step 1.2: Extract PostTracker

**Create:** `src/operations/post-tracker.ts`

Replace `SessionManager.postIndex: Map<string, string>` with typed tracker:

```typescript
// src/operations/post-tracker.ts
export type PostType = 'content' | 'task_list' | 'interactive' | 'system' | 'subagent' | 'status';
export type InteractionType = 'question' | 'plan_approval' | 'message_approval' | 'worktree' | 'context';

export interface PostInfo {
  postId: string;
  threadId: string;
  sessionId: string;
  type: PostType;
  interactionType?: InteractionType;
  createdAt: number;
}

export class PostTracker {
  private posts = new Map<string, PostInfo>();

  register(info: PostInfo): void;
  unregister(postId: string): void;
  get(postId: string): PostInfo | undefined;
  findSessionForPost(postId: string): string | undefined;
  getPostsForSession(sessionId: string): PostInfo[];
  clear(): void;
}
```

**Wire up:**
- Replace `SessionManager.postIndex` with `PostTracker` instance
- Replace `registerPost(postId, threadId)` calls with `postTracker.register({...})`
- Update `reactions.ts` to use `postTracker.get(postId)` for routing

#### Step 1.3: Create ToolFormatterRegistry

**Create:** `src/operations/tool-formatters/`

```
src/operations/tool-formatters/
├── types.ts           # Interfaces
├── registry.ts        # Registry class
├── file-tools.ts      # Read, Write, Edit, Glob, Grep
├── bash-tools.ts      # Bash
├── task-tools.ts      # TodoWrite, Task, EnterPlanMode, ExitPlanMode
├── chrome-tools.ts    # mcp__claude-in-chrome__*
├── mcp-tools.ts       # Generic MCP tools
└── index.ts           # Exports
```

**Interface:**
```typescript
// src/operations/tool-formatters/types.ts
export interface ToolFormatOptions {
  worktreePath?: string;  // For path shortening
  includeInput?: boolean; // For permission prompts
}

export interface ToolFormatResult {
  /** Formatted display for chat (null = don't display this tool) */
  display: string | null;
  /** Short description for permission prompts */
  permissionText: string;
  /** Whether this tool modifies files/state */
  isDestructive: boolean;
}

export interface ToolFormatter {
  readonly toolNames: string[];  // Tools this formatter handles
  format(toolName: string, input: unknown, options: ToolFormatOptions): ToolFormatResult;
}
```

**Wire up:**
- Create `ToolFormatterRegistry` singleton
- Replace `formatToolUse()` calls with `registry.format()`
- Replace `formatToolForPermission()` calls with `registry.format(...).permissionText`

---

### Phase 2: Operation Types (Low Risk) - PR #2

**Goal:** Define the operation model. No runtime changes.

#### Step 2.1: Define Operation Types

**Create:** `src/operations/types.ts`

```typescript
// Base
interface BaseOperation {
  type: string;
  timestamp: number;
  sessionId: string;
}

// Content streaming
interface AppendContentOp extends BaseOperation {
  type: 'append_content';
  content: string;
  contentType: 'text' | 'tool_use' | 'tool_result';
  toolUseId?: string;
}

interface FlushOp extends BaseOperation {
  type: 'flush';
  reason: 'timer' | 'break_point' | 'interactive' | 'end_turn' | 'explicit';
}

// Task list
interface TaskListOp extends BaseOperation {
  type: 'task_list';
  action: 'update' | 'bump' | 'toggle_minimize';
  content: string;
  progress: { done: number; total: number };
}

// Interactive posts
interface QuestionOp extends BaseOperation {
  type: 'question';
  toolUseId: string;
  question: string;
  options: Array<{ label: string; emoji: string }>;
}

interface ApprovalOp extends BaseOperation {
  type: 'approval';
  approvalType: 'plan' | 'message' | 'worktree' | 'context';
  toolUseId?: string;
  content: string;
}

// System messages
interface SystemMessageOp extends BaseOperation {
  type: 'system_message';
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
}

// Subagents
interface SubagentOp extends BaseOperation {
  type: 'subagent';
  action: 'start' | 'update' | 'complete' | 'toggle_minimize';
  toolUseId: string;
  description: string;
  subagentType: string;
}

// Status bar
interface StatusUpdateOp extends BaseOperation {
  type: 'status_update';
}

export type MessageOperation =
  | AppendContentOp
  | FlushOp
  | TaskListOp
  | QuestionOp
  | ApprovalOp
  | SystemMessageOp
  | SubagentOp
  | StatusUpdateOp;
```

#### Step 2.2: Create EventTransformer (test-only)

**Create:** `src/operations/transformer.ts` + `src/operations/transformer.test.ts`

```typescript
// src/operations/transformer.ts
import type { ClaudeEvent } from '../claude/cli.js';
import type { MessageOperation } from './types.js';
import type { ToolFormatterRegistry } from './tool-formatters/index.js';

export interface TransformContext {
  sessionId: string;
  worktreePath?: string;
  toolFormatter: ToolFormatterRegistry;
}

export function transformEvent(
  event: ClaudeEvent,
  context: TransformContext
): MessageOperation[] {
  switch (event.type) {
    case 'assistant':
      return transformAssistant(event, context);
    case 'tool_use':
      return transformToolUse(event, context);
    case 'tool_result':
      return transformToolResult(event, context);
    case 'result':
      return transformResult(event, context);
    default:
      return [];
  }
}
```

**Tests:** Use real Claude event samples from integration test fixtures.

---

### Phase 3: Executors (Medium Risk) - PR #3

**Goal:** Implement executors that can run alongside existing code.

#### Step 3.1: Create Executor Interfaces

**Create:** `src/operations/executors/types.ts`

```typescript
export interface ExecutorContext {
  platform: PlatformClient;
  postTracker: PostTracker;
  session: Session;  // For state updates
}

export interface Executor<T extends MessageOperation> {
  execute(op: T, context: ExecutorContext): Promise<void>;
}
```

#### Step 3.2: ContentExecutor

**Create:** `src/operations/executors/content.ts`

Handles: `AppendContentOp`, `FlushOp`

Key responsibilities:
- Accumulate content from `AppendContentOp`
- On `FlushOp`: format, break, post/update
- Track `currentPostId` and `currentPostContent`

```typescript
export class ContentExecutor {
  private pendingContent = '';
  private contentBreaker: ContentBreaker;

  async execute(op: AppendContentOp | FlushOp, ctx: ExecutorContext): Promise<void> {
    if (op.type === 'append_content') {
      this.pendingContent += op.content;
      return;
    }

    // Flush
    if (!this.pendingContent) return;

    const formatted = ctx.platform.getFormatter().formatMarkdown(this.pendingContent);
    const chunks = this.contentBreaker.break(formatted, ctx.platform.getMessageLimits().maxLength);

    for (const chunk of chunks) {
      await this.postChunk(chunk, ctx);
    }

    this.pendingContent = '';
  }
}
```

#### Step 3.3: TaskListExecutor

**Create:** `src/operations/executors/task-list.ts`

Handles: `TaskListOp`

Key responsibilities:
- Create/update task list post
- Bump to bottom when content is posted
- Toggle minimize state

```typescript
export class TaskListExecutor {
  async execute(op: TaskListOp, ctx: ExecutorContext): Promise<void> {
    switch (op.action) {
      case 'update':
        await this.updateTaskList(op, ctx);
        break;
      case 'bump':
        await this.bumpToBottom(ctx);
        break;
      case 'toggle_minimize':
        await this.toggleMinimize(ctx);
        break;
    }
  }

  private async bumpToBottom(ctx: ExecutorContext): Promise<void> {
    const { session, platform, postTracker } = ctx;
    if (!session.tasksPostId || !session.lastTasksContent) return;

    // Delete old
    await platform.deletePost(session.tasksPostId);
    postTracker.unregister(session.tasksPostId);

    // Create new at bottom
    const post = await platform.createPost(session.threadId, session.lastTasksContent);
    session.tasksPostId = post.id;
    postTracker.register({
      postId: post.id,
      threadId: session.threadId,
      sessionId: session.sessionId,
      type: 'task_list',
      createdAt: Date.now(),
    });
  }
}
```

#### Step 3.4: InteractiveExecutor

**Create:** `src/operations/executors/interactive.ts`

Handles: `QuestionOp`, `ApprovalOp`

```typescript
export class InteractiveExecutor {
  async execute(op: QuestionOp | ApprovalOp, ctx: ExecutorContext): Promise<void> {
    if (op.type === 'question') {
      await this.postQuestion(op, ctx);
    } else {
      await this.postApproval(op, ctx);
    }
  }
}
```

---

### Phase 4: MessageManager & Integration (Higher Risk) - PR #4

**Goal:** Wire everything together with feature flag.

#### Step 4.1: Create MessageManager

**Create:** `src/operations/message-manager.ts`

```typescript
export class MessageManager {
  private contentExecutor: ContentExecutor;
  private taskListExecutor: TaskListExecutor;
  private interactiveExecutor: InteractiveExecutor;
  private postTracker: PostTracker;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(platform: PlatformClient, postTracker: PostTracker) {
    this.contentExecutor = new ContentExecutor(new DefaultContentBreaker());
    this.taskListExecutor = new TaskListExecutor();
    this.interactiveExecutor = new InteractiveExecutor();
    this.postTracker = postTracker;
  }

  async handleEvent(event: ClaudeEvent, session: Session): Promise<void> {
    const ops = transformEvent(event, {
      sessionId: session.sessionId,
      worktreePath: session.worktreeInfo?.worktreePath,
      toolFormatter: getToolFormatterRegistry(),
    });

    for (const op of ops) {
      await this.executeOperation(op, session);
    }
  }

  private async executeOperation(op: MessageOperation, session: Session): Promise<void> {
    const ctx: ExecutorContext = {
      platform: session.platform,
      postTracker: this.postTracker,
      session,
    };

    switch (op.type) {
      case 'append_content':
      case 'flush':
        await this.contentExecutor.execute(op, ctx);
        break;
      case 'task_list':
        await this.taskListExecutor.execute(op, ctx);
        break;
      case 'question':
      case 'approval':
        await this.interactiveExecutor.execute(op, ctx);
        break;
      // ... etc
    }
  }
}
```

#### Step 4.2: Feature Flag Integration

**Modify:** `src/session/events.ts`

```typescript
const USE_NEW_MESSAGE_MANAGER = process.env.USE_NEW_MESSAGE_MANAGER === '1';

export async function handleEvent(event: ClaudeEvent, ctx: SessionContext): Promise<void> {
  if (USE_NEW_MESSAGE_MANAGER) {
    await ctx.messageManager.handleEvent(event, ctx.session);
    return;
  }

  // Existing code path (unchanged)
  // ...
}
```

#### Step 4.3: Parallel Validation Mode

For testing, run both paths and compare:

```typescript
const VALIDATE_NEW_PIPELINE = process.env.VALIDATE_NEW_PIPELINE === '1';

if (VALIDATE_NEW_PIPELINE) {
  // Run old path
  const oldResult = await handleEventOld(event, ctx);

  // Run new path (dry run, capture operations)
  const newOps = transformEvent(event, transformCtx);

  // Log differences for analysis
  logPipelineComparison(oldResult, newOps);
}
```

---

### Phase 5: Cleanup - PR #5

**Goal:** Remove old code once new pipeline is validated.

#### Step 5.1: Remove Old Streaming Code

- Delete `src/session/streaming.ts` (replaced by ContentExecutor + TaskListExecutor)
- Remove `bumpTasksToBottom`, `bumpTasksToBottomWithContent` functions
- Remove `acquireTaskListLock` mechanism

#### Step 5.2: Simplify events.ts

- Remove inline content assembly
- Remove tool formatting calls (now in transformer)
- Keep only: event routing to MessageManager

#### Step 5.3: Update Session Type

Remove now-unused fields:
- `pendingContent` → managed by ContentExecutor
- `updateTimer` → managed by MessageManager
- `taskListCreationPromise` → handled by TaskListExecutor

#### Step 5.4: Remove Feature Flags

- Remove `USE_NEW_MESSAGE_MANAGER`
- Remove `VALIDATE_NEW_PIPELINE`
- Make new pipeline the only path

---

## Part 5: File Structure

```
src/
├── operations/
│   ├── types.ts                 # Operation type definitions
│   ├── transformer.ts           # Event → Operations
│   ├── queue.ts                 # Operation batching & scheduling
│   ├── content-breaker.ts       # Logical content breaking
│   ├── post-tracker.ts          # Post registration & lookup
│   ├── message-manager.ts       # Orchestrator
│   ├── executors/
│   │   ├── content.ts           # AppendContent, FlushContent
│   │   ├── task-list.ts         # TaskList operations
│   │   ├── interactive.ts       # Questions, approvals
│   │   ├── system.ts            # Info/warning/error messages
│   │   ├── status.ts            # Session header updates
│   │   └── subagent.ts          # Subagent status
│   ├── tool-formatters/
│   │   ├── registry.ts          # Formatter registry
│   │   ├── file.ts              # Read/Write/Edit
│   │   ├── bash.ts              # Bash commands
│   │   ├── search.ts            # Glob/Grep
│   │   ├── chrome.ts            # Browser automation
│   │   └── mcp.ts               # MCP tools
│   └── index.ts                 # Public exports
├── session/
│   ├── manager.ts               # Simplified (delegates to MessageManager)
│   ├── events.ts                # Simplified (calls MessageManager.handleEvent)
│   ├── reactions.ts             # Uses PostTracker for routing
│   └── ...
└── platform/
    └── ...                      # Unchanged
```

---

## Part 6: Testing Strategy

### Unit Tests

1. **ContentBreaker** - Various content patterns, code blocks, headings
2. **EventTransformer** - Every Claude event type with real samples
3. **OperationQueue** - Batching, flush timing, edge cases
4. **Each Executor** - Operation → expected platform calls

### Integration Tests

1. **End-to-end message flow** - Claude event → chat post
2. **Task list scenarios** - Create, update, bump, minimize
3. **Interactive flows** - Questions, approvals with reactions
4. **Race conditions** - Concurrent events, rapid updates

### Regression Tests

1. **Output comparison** - Same Claude events → same chat output
2. **State consistency** - Session state matches expected
3. **Performance** - No increase in API calls or latency

---

## Part 7: Benefits Summary

| Current Pain Point | New Architecture Solution |
|-------------------|--------------------------|
| 900-line streaming.ts | Split into ContentBreaker + ContentExecutor (~200 lines each) |
| Task list locking | TaskListExecutor handles atomically |
| Tool formatting scattered | ToolFormatterRegistry with plugins |
| Event handler god-function | EventTransformer (pure functions) + MessageManager (orchestration) |
| Post tracking ad-hoc | PostTracker with typed post info |
| Race conditions | OperationQueue serializes execution |
| Hard to test | Each component testable in isolation |
| Hard to add platforms | Executors are platform-agnostic |

---

## Part 8: Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Behavior differences | Medium | High | Parallel execution mode, output comparison |
| Performance regression | Low | Medium | Benchmark API calls before/after |
| Migration breaks sessions | Low | High | Feature flags, rollback capability |
| Increased complexity | Low | Medium | Clear module boundaries, good docs |
| Extended timeline | Medium | Medium | Incremental phases, each phase is shippable |

---

## Conclusion

This refactor addresses the core complexity in claude-threads around message handling. By introducing an operation-based model, we:

1. **Separate concerns** - Transformation, queueing, execution are distinct
2. **Enable testing** - Pure functions and isolated executors
3. **Reduce coupling** - Platform-agnostic operations
4. **Simplify maintenance** - Clear data flow, no race conditions
5. **Enable extensibility** - Plugin system for tools

The migration path is incremental, with each phase delivering testable improvements while maintaining backward compatibility.
