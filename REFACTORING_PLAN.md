# Claude-Threads Refactoring Plan

## Executive Summary

This plan addresses code quality issues identified in the claude-threads codebase to achieve:
- **DRY (Don't Repeat Yourself)** - Eliminate 50+ duplicated patterns
- **Composability** - Unified context system, reusable modules
- **Maintainability** - Consistent patterns, centralized error handling
- **Extensibility** - Better platform abstraction, clear extension points
- **Security** - Standardized input validation, consistent error handling

**Estimated scope**: ~15-20 focused refactoring tasks across 6 phases

---

## Phase 1: Foundation - Unified Context System

**Goal**: Eliminate the 4 overlapping context interfaces and 18+ wrapper functions

### 1.1 Create Unified SessionContext Interface

**Problem**: `LifecycleContext`, `EventContext`, `ReactionContext`, and `CommandContext` have ~70% overlap with 18+ wrapper functions that just forward to SessionManager methods.

**Current state** (manager.ts:115-187):
```typescript
private getLifecycleContext(): LifecycleContext {
  return {
    // 18+ wrapper functions like:
    flush: (s) => this.flush(s),
    startTyping: (s) => this.startTyping(s),
    // ... many more
  };
}
```

**Solution**: Create a single `SessionContext` interface that modules receive:

```typescript
// src/session/context.ts (NEW FILE)
export interface SessionContext {
  // Configuration (read-only)
  readonly config: SessionConfig;

  // State access
  readonly sessions: ReadonlyMap<string, Session>;
  readonly platforms: ReadonlyMap<string, PlatformClient>;

  // Core operations
  manager: SessionManagerOperations;
}

export interface SessionConfig {
  workingDir: string;
  skipPermissions: boolean;
  chromeEnabled: boolean;
  debug: boolean;
  maxSessions: number;
}

export interface SessionManagerOperations {
  // Post management
  registerPost(postId: string, threadId: string): void;

  // Streaming
  flush(session: Session): Promise<void>;
  appendContent(session: Session, text: string): void;

  // Typing indicators
  startTyping(session: Session): void;
  stopTyping(session: Session): void;

  // Persistence
  persistSession(session: Session): void;
  unpersistSession(sessionId: string): void;

  // UI updates
  updateSessionHeader(session: Session): Promise<void>;
  updateStickyMessage(): Promise<void>;
  bumpTasksToBottom(session: Session): Promise<void>;

  // Session lifecycle
  killSession(threadId: string): Promise<void>;
  getSessionId(platformId: string, threadId: string): string;
  findSessionByThreadId(threadId: string): Session | undefined;

  // Event handling
  handleEvent(sessionId: string, event: ClaudeEvent): void;
  handleExit(sessionId: string, code: number): Promise<void>;

  // Worktree
  shouldPromptForWorktree(session: Session): Promise<string | null>;
  postWorktreePrompt(session: Session, reason: string): Promise<void>;

  // Context prompt
  offerContextPrompt(session: Session, queuedPrompt: string, excludePostId?: string): Promise<boolean>;

  // Content building
  buildMessageContent(text: string, platform: PlatformClient, files?: PlatformFile[]): Promise<string | ContentBlock[]>;
}
```

**Files to modify**:
- `src/session/context.ts` (new)
- `src/session/manager.ts` - implement SessionManagerOperations, remove 4 context builder methods
- `src/session/lifecycle.ts` - accept SessionContext instead of LifecycleContext
- `src/session/events.ts` - accept SessionContext instead of EventContext
- `src/session/reactions.ts` - accept SessionContext instead of ReactionContext
- `src/session/commands.ts` - accept SessionContext instead of CommandContext
- `src/session/types.ts` - export new types

**Benefit**: Reduces ~100 lines of boilerplate, single source of truth for module dependencies.

---

## Phase 2: DRY - Extract Common Patterns

### 2.1 Extract Post Helper Utilities

**Problem**: 50+ occurrences of `session.platform.createPost()` across 6 files with inconsistent formatting.

**Solution**: Create `src/session/post-helpers.ts`:

```typescript
// src/session/post-helpers.ts (NEW FILE)
import type { Session } from './types.js';

export async function postInfo(session: Session, message: string): Promise<string> {
  const post = await session.platform.createPost(message, session.threadId);
  return post.id;
}

export async function postSuccess(session: Session, message: string): Promise<string> {
  return postInfo(session, `✅ ${message}`);
}

export async function postWarning(session: Session, message: string): Promise<string> {
  return postInfo(session, `⚠️ ${message}`);
}

export async function postError(session: Session, message: string): Promise<string> {
  return postInfo(session, `❌ ${message}`);
}

export async function postSecure(session: Session, message: string): Promise<string> {
  return postInfo(session, `🔐 ${message}`);
}

export async function postCommand(session: Session, message: string): Promise<string> {
  return postInfo(session, `⚙️ ${message}`);
}

// For permission-style messages with reaction options
export async function postWithReactions(
  session: Session,
  message: string,
  reactions: string[]
): Promise<string> {
  const post = await session.platform.createPost(message, session.threadId);
  for (const emoji of reactions) {
    await session.platform.addReaction(post.id, emoji);
  }
  return post.id;
}
```

**Files to update**: `commands.ts`, `lifecycle.ts`, `worktree.ts`, `reactions.ts`, `streaming.ts`

**Benefit**: Consistent formatting, single place to add logging/metrics.

---

### 2.2 Extract Session ID Formatting

**Problem**: 15 occurrences of `threadId.substring(0, 8)` with inconsistent formatting.

**Solution**: Add to `src/utils/format.ts` (NEW FILE):

```typescript
// src/utils/format.ts (NEW FILE)

/**
 * Format a session/thread ID for display (first 8 chars + ellipsis)
 */
export function formatShortId(id: string): string {
  return `${id.substring(0, 8)}…`;
}

/**
 * Format session action for console logging
 */
export function logSessionAction(
  emoji: string,
  action: string,
  threadId: string,
  username?: string
): void {
  const shortId = formatShortId(threadId);
  const userPart = username ? ` by @${username}` : '';
  console.log(`  ${emoji} ${action} (${shortId})${userPart}`);
}

// Pre-defined log helpers
export const sessionLog = {
  started: (threadId: string, user: string, dir: string) =>
    console.log(`  ✅ Session started (${formatShortId(threadId)}) by @${user} in ${dir}`),

  cancelled: (threadId: string, user: string) =>
    logSessionAction('🛑', 'Session cancelled', threadId, user),

  timeout: (threadId: string) =>
    logSessionAction('⏱️', 'Session timed out', threadId),

  resumed: (threadId: string, user: string) =>
    logSessionAction('🔄', 'Session resumed', threadId, user),

  error: (threadId: string, error: string) =>
    console.error(`  ⚠️ Session (${formatShortId(threadId)}): ${error}`),
};
```

**Benefit**: Consistent logging, easy to add structured logging later.

---

### 2.3 Standardize Console Logging

**Problem**: 44+ console.log/error calls with inconsistent prefixes and formats.

**Solution**: Enhance `src/utils/logger.ts`:

```typescript
// src/utils/logger.ts (ENHANCE)
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, error?: Error): void;
}

export function createLogger(component: string): Logger {
  const prefix = `[${component}]`;
  const debugEnabled = process.env.DEBUG === '1';

  return {
    debug: (msg, ...args) => {
      if (debugEnabled) console.log(`  ${prefix} ${msg}`, ...args);
    },
    info: (msg, ...args) => console.log(`  ${prefix} ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`  ⚠️ ${prefix} ${msg}`, ...args),
    error: (msg, err) => {
      console.error(`  ❌ ${prefix} ${msg}`);
      if (err && debugEnabled) console.error(err);
    },
  };
}

// Pre-instantiated loggers for common components
export const lifecycleLogger = createLogger('lifecycle');
export const eventsLogger = createLogger('events');
export const commandsLogger = createLogger('commands');
export const worktreeLogger = createLogger('worktree');
export const streamingLogger = createLogger('streaming');
```

**Benefit**: Consistent output, debug mode toggle, structured format.

---

## Phase 3: Error Handling Standardization

### 3.1 Create Centralized Error Handler

**Problem**: 132 try-catch blocks with 4 different patterns (silent, logged, rethrown, Promise.catch).

**Solution**: Create `src/session/error-handler.ts`:

```typescript
// src/session/error-handler.ts (NEW FILE)
import type { Session } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('error');

export type ErrorSeverity = 'recoverable' | 'session-fatal' | 'system-fatal';

export interface SessionErrorContext {
  action: string;
  session?: Session;
  shouldNotifyUser?: boolean;
}

/**
 * Handle errors consistently across the codebase
 */
export async function handleError(
  error: unknown,
  context: SessionErrorContext,
  severity: ErrorSeverity = 'recoverable'
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  // Always log
  if (context.session) {
    logger.error(`${context.action} in session ${context.session.threadId.substring(0, 8)}: ${message}`);
  } else {
    logger.error(`${context.action}: ${message}`);
  }

  // Notify user for recoverable errors if requested
  if (severity === 'recoverable' && context.shouldNotifyUser && context.session) {
    try {
      await context.session.platform.createPost(
        `⚠️ **Error**: ${context.action} failed. Please try again.`,
        context.session.threadId
      );
    } catch {
      // Can't notify user, just log
      logger.warn('Could not notify user of error');
    }
  }

  // Re-throw fatal errors
  if (severity === 'session-fatal' || severity === 'system-fatal') {
    throw error;
  }
}

/**
 * Wrapper for async operations with consistent error handling
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  context: SessionErrorContext,
  severity: ErrorSeverity = 'recoverable'
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    await handleError(error, context, severity);
    return undefined;
  }
}
```

**Usage example**:
```typescript
// Before:
try {
  await session.platform.updatePost(postId, message);
} catch (err) {
  console.error('  ⚠️ Failed to update post:', err);
}

// After:
await withErrorHandling(
  () => session.platform.updatePost(postId, message),
  { action: 'Update post', session }
);
```

**Files to update**: All files with try-catch blocks (lifecycle.ts, events.ts, commands.ts, worktree.ts, streaming.ts, reactions.ts)

**Benefit**: Consistent error handling, easier debugging, user notifications.

---

## Phase 4: Type Consolidation

### 4.1 Consolidate Session Types

**Problem**: Session-related types scattered across 6 files.

**Current locations**:
- `session/types.ts` - Session, PendingApproval, etc.
- `session/lifecycle.ts:22-50` - LifecycleContext
- `session/events.ts:26-37` - EventContext
- `session/reactions.ts:21-27` - ReactionContext
- `session/commands.ts:63-76` - CommandContext
- `persistence/session-store.ts:28-62` - PersistedSession

**Solution**: Move all to `src/session/types.ts`:

```typescript
// src/session/types.ts (CONSOLIDATE)

// =============================================================================
// Re-export persistence types (keep definition there, but export from here)
// =============================================================================
export type { PersistedSession, WorktreeInfo } from '../persistence/session-store.js';

// =============================================================================
// Context types (moved from individual modules)
// =============================================================================
export interface SessionContext { /* from Phase 1 */ }
export interface SessionConfig { /* from Phase 1 */ }
export interface SessionManagerOperations { /* from Phase 1 */ }

// =============================================================================
// Session type and related
// =============================================================================
export interface Session { /* existing */ }
export interface SessionUsageStats { /* existing */ }
// ... rest of existing types
```

**Benefit**: Single import location, clear type organization.

---

## Phase 5: Platform Extensibility

### 5.1 Create Platform Implementation Guide

**Problem**: No clear guide for implementing new platforms (Slack is "architecture ready").

**Solution**: Create `src/platform/IMPLEMENTATION_GUIDE.md`:

```markdown
# Implementing a New Platform

## Required Steps

1. Create platform directory: `src/platform/{platform-name}/`
2. Implement `PlatformClient` interface
3. Implement `PlatformFormatter` for markdown dialect
4. Implement `PermissionApi` for MCP integration
5. Add platform type to config schema
6. Register in onboarding wizard

## Required Files

```
src/platform/{platform}/
├── client.ts      # PlatformClient implementation
├── formatter.ts   # Markdown formatting
├── types.ts       # Platform-specific types
└── permission-api.ts  # Permission API for MCP
```

## Interface Checklist

### PlatformClient (required methods)
- [ ] connect(): Promise<void>
- [ ] createPost(message, threadId?): Promise<PlatformPost>
- [ ] updatePost(postId, message): Promise<PlatformPost>
- [ ] deletePost(postId): Promise<void>
- [ ] addReaction(postId, emoji): Promise<void>
- [ ] removeReaction(postId, emoji): Promise<void>
- [ ] getPost(postId): Promise<PlatformPost>
- [ ] getUser(userId): Promise<PlatformUser>
- [ ] getUserByUsername(username): Promise<PlatformUser>
- [ ] getThreadHistory(threadId): Promise<PlatformPost[]>
- [ ] uploadFile(filename, content, channelId): Promise<string>
- [ ] isUserAllowed(username): boolean
- [ ] setTyping(channelId, typing): Promise<void>

### Events to emit
- 'message': (post: PlatformPost, user: PlatformUser) => void
- 'reaction': (reaction: PlatformReaction, user: PlatformUser) => void
- 'channel_post': () => void
```

**Benefit**: Clear path to implement Slack, Discord, etc.

---

### 5.2 Extract Platform-Agnostic Utilities

**Problem**: Some utilities are tightly coupled to specific platforms.

**Solution**: Ensure `src/platform/utils.ts` has platform-agnostic helpers:

```typescript
// src/platform/utils.ts (NEW FILE)

/**
 * Normalize message content across platforms
 */
export function normalizeMessage(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

/**
 * Split long messages at natural breakpoints
 */
export function splitMessage(content: string, maxLength: number): string[] {
  // Implementation from streaming.ts, made generic
}

/**
 * Extract mentions from message text
 */
export function extractMentions(content: string): string[] {
  const mentionRegex = /@(\w+)/g;
  const matches = content.matchAll(mentionRegex);
  return Array.from(matches, m => m[1]);
}
```

---

## Phase 6: Testing & Documentation

### 6.1 Add Integration Tests for Core Modules

**Problem**: Core modules (SessionManager, lifecycle, commands) have no tests.

**Solution**: Create test files:

```
src/session/__tests__/
├── manager.integration.test.ts
├── lifecycle.test.ts
├── commands.test.ts
└── worktree.test.ts
```

**Test strategy**:
```typescript
// src/session/__tests__/lifecycle.test.ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import * as lifecycle from '../lifecycle.js';

describe('lifecycle', () => {
  describe('startSession', () => {
    it('should create session with correct properties', async () => {
      // Mock platform client
      const mockPlatform = createMockPlatform();
      const mockContext = createMockContext({ platforms: new Map([['test', mockPlatform]]) });

      const session = await lifecycle.startSession(
        'test',
        'thread-123',
        'testuser',
        'Test User',
        '/tmp/test',
        mockContext
      );

      expect(session.threadId).toBe('thread-123');
      expect(session.startedBy).toBe('testuser');
    });
  });
});
```

### 6.2 Update CLAUDE.md with Architecture Changes

After refactoring, update CLAUDE.md:
- Document new module structure
- Update file descriptions
- Add refactoring rationale

---

## Implementation Order

### Week 1: Foundation
1. **Phase 1.1**: Create unified SessionContext interface
2. **Phase 2.1**: Extract post helper utilities
3. **Phase 2.2**: Extract session ID formatting

### Week 2: Standardization
4. **Phase 2.3**: Standardize console logging
5. **Phase 3.1**: Create centralized error handler
6. **Phase 4.1**: Consolidate session types

### Week 3: Platform & Polish
7. **Phase 5.1**: Create platform implementation guide
8. **Phase 5.2**: Extract platform-agnostic utilities
9. **Phase 6.1**: Add integration tests

### Week 4: Documentation
10. **Phase 6.2**: Update documentation

---

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Duplicate `createPost` calls | 50+ | <10 (via helpers) |
| Context interfaces | 4 | 1 |
| Wrapper functions in manager.ts | 18+ | 0 |
| ID formatting duplications | 15 | 0 |
| Console.log inconsistencies | 44+ | 0 (via logger) |
| Try-catch pattern variations | 4 | 1 |
| Test coverage (core modules) | ~30% | >70% |
| Time to implement new platform | Unknown | <2 days |

---

## Risk Mitigation

1. **Breaking changes**: Each phase is independently deployable. Test thoroughly between phases.

2. **Regression risk**: Run full test suite after each change. Add tests before refactoring critical paths.

3. **Context object migration**: Migrate one module at a time, keep old interfaces temporarily for backwards compatibility.

4. **Error handling migration**: Add new error handler alongside existing try-catch, migrate incrementally.

---

## Files Created/Modified Summary

### New Files
- `src/session/context.ts` - Unified context interface
- `src/session/post-helpers.ts` - Post creation utilities
- `src/session/error-handler.ts` - Centralized error handling
- `src/utils/format.ts` - ID formatting and logging utilities
- `src/platform/utils.ts` - Platform-agnostic utilities
- `src/platform/IMPLEMENTATION_GUIDE.md` - Platform extension guide
- `src/session/__tests__/*.test.ts` - Integration tests

### Modified Files
- `src/session/manager.ts` - Remove context builders, implement SessionManagerOperations
- `src/session/lifecycle.ts` - Use SessionContext, post helpers, error handler
- `src/session/events.ts` - Use SessionContext, post helpers, error handler
- `src/session/commands.ts` - Use SessionContext, post helpers, error handler
- `src/session/reactions.ts` - Use SessionContext, post helpers, error handler
- `src/session/worktree.ts` - Use SessionContext, post helpers, error handler
- `src/session/streaming.ts` - Use post helpers, error handler
- `src/session/types.ts` - Consolidate all types
- `src/utils/logger.ts` - Enhance with component loggers
- `CLAUDE.md` - Update architecture documentation
