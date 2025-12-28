# Code Quality Refactoring Plan

**Created:** 2025-12-28
**Status:** Proposed
**Estimated Impact:** ~200-250 lines of duplication eliminated

---

## ⚠️ Prerequisites: Test Coverage First

Before refactoring, we need test infrastructure to catch regressions. Currently the project has **no test framework or tests**.

### Why Tests First?

1. **Safety Net** - Refactoring without tests is risky; we might break existing functionality
2. **Confidence** - Tests prove the refactored code behaves identically to the original
3. **Documentation** - Tests serve as executable documentation of expected behavior
4. **Regression Prevention** - Future changes won't silently break things

### Recommended Approach

Start with unit tests for the code we're about to extract/modify, then proceed with refactoring.

---

## Executive Summary

Analysis of the codebase identified **7 areas of code duplication**, primarily between `src/mcp/permission-server.ts` and the core bot code. The permission MCP server was developed as a standalone component and duplicates functionality that already exists in the main codebase.

**Key Problems:**
- Tool formatting logic duplicated across 2 files (~100 lines)
- Mattermost REST API calls reimplemented in permission server (~70 lines)
- Emoji/reaction handling repeated in 3+ places
- Post + reactions pattern used 4+ times without abstraction

---

## Refactoring Tasks

### Phase 1: High Impact Extractions

#### 1.1 Extract Shared Mattermost API Layer

**Problem:** The permission server (`src/mcp/permission-server.ts:59-130`) implements raw fetch calls to Mattermost API, while `client.ts` has an abstracted `api()` helper. Both do the same thing differently.

**Current State:**
```
permission-server.ts          client.ts
─────────────────────         ─────────────
fetch(${MM_URL}/api/v4/...)   api<T>(method, path, body)
  + manual headers              + typed response
  + no error details            + detailed errors
  + hardcoded config            + config object
```

**Solution:** Create `src/mattermost/api.ts` with a standalone API helper that both can use.

**New File:** `src/mattermost/api.ts`
```typescript
export interface MattermostApiConfig {
  url: string;
  token: string;
}

export async function mattermostApi<T>(
  config: MattermostApiConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<T>;

// Convenience functions
export async function getMe(config: MattermostApiConfig): Promise<User>;
export async function getUser(config: MattermostApiConfig, userId: string): Promise<User | null>;
export async function createPost(config: MattermostApiConfig, post: CreatePostRequest): Promise<Post>;
export async function addReaction(config: MattermostApiConfig, postId: string, userId: string, emoji: string): Promise<void>;
export async function updatePost(config: MattermostApiConfig, postId: string, message: string): Promise<Post>;
```

**Changes Required:**
1. Create `src/mattermost/api.ts` with shared API functions
2. Update `src/mattermost/client.ts` to use the shared layer (keeping WebSocket logic)
3. Update `src/mcp/permission-server.ts` to import from api.ts instead of raw fetch
4. Export types from `src/mattermost/types.ts` if not already

**Files Affected:**
- `src/mattermost/api.ts` (new)
- `src/mattermost/client.ts` (refactor to use api.ts)
- `src/mcp/permission-server.ts` (replace fetch calls with api.ts)

**Lines Eliminated:** ~70

---

#### 1.2 Extract Tool Formatter Utility

**Problem:** Both `permission-server.ts:214-237` and `session.ts:1068-1169` have nearly identical tool formatting functions with duplicated switch cases for Read, Write, Edit, Bash, etc.

**Current State:**
```
permission-server.ts           session.ts
────────────────────           ──────────
formatToolInfo()               formatToolUse()
  - short() helper               - short() helper (identical)
  - Read → 📄 format             - Read → 📄 format (identical)
  - Write → 📝 format            - Write → 📝 format + preview
  - Bash → 💻 (100 chars)        - Bash → 💻 (50 chars) ← inconsistent!
  - MCP tool parsing             - MCP tool parsing (same)
```

**Solution:** Create `src/utils/tool-formatter.ts` with the base formatting logic.

**New File:** `src/utils/tool-formatter.ts`
```typescript
export interface ToolInput {
  [key: string]: unknown;
}

export interface FormatOptions {
  /** Include detailed previews (diffs, file content) */
  detailed?: boolean;
  /** Max command length for Bash */
  maxCommandLength?: number;
  /** Max path display length */
  maxPathLength?: number;
}

/** Shorten a file path for display */
export function shortenPath(path: string, maxLength?: number): string;

/** Format a tool use for display in Mattermost */
export function formatToolUse(
  toolName: string,
  input: ToolInput,
  options?: FormatOptions
): string | null;

/** Check if a tool name is an MCP tool and extract the server/tool name */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null;
```

**Changes Required:**
1. Create `src/utils/tool-formatter.ts` with shared formatting
2. Update `session.ts` to use `formatToolUse()` with `detailed: true`
3. Update `permission-server.ts` to use `formatToolUse()` with `detailed: false`
4. Standardize Bash command truncation (pick one: 50 or 100 chars)

**Files Affected:**
- `src/utils/tool-formatter.ts` (new)
- `src/claude/session.ts` (import and use)
- `src/mcp/permission-server.ts` (import and use)

**Lines Eliminated:** ~100

---

### Phase 2: Medium Impact Improvements

#### 2.1 Create Emoji Constants and Helpers

**Problem:** Emoji variant checks repeated across files:
- `permission-server.ts:283-293`
- `session.ts:911-912`
- `session.ts:955-957`

**Current State:**
```typescript
// Repeated 3+ times:
emoji === '+1' || emoji === 'thumbsup'
emoji === '-1' || emoji === 'thumbsdown'
emoji === 'white_check_mark' || emoji === 'heavy_check_mark'
```

**Solution:** Create `src/mattermost/emoji.ts` with constants and helpers.

**New File:** `src/mattermost/emoji.ts`
```typescript
/** Emoji names that indicate approval */
export const APPROVAL_EMOJIS = ['+1', 'thumbsup'] as const;

/** Emoji names that indicate denial */
export const DENIAL_EMOJIS = ['-1', 'thumbsdown'] as const;

/** Emoji names that indicate "allow all" / invite */
export const ALLOW_ALL_EMOJIS = ['white_check_mark', 'heavy_check_mark'] as const;

/** Number emojis for multi-choice questions */
export const NUMBER_EMOJIS = ['one', 'two', 'three', 'four'] as const;

/** Emojis for session control */
export const CANCEL_EMOJIS = ['x', 'octagonal_sign'] as const;
export const ESCAPE_EMOJIS = ['double_vertical_bar', 'pause_button'] as const;

// Helper functions
export function isApprovalEmoji(emoji: string): boolean;
export function isDenialEmoji(emoji: string): boolean;
export function isAllowAllEmoji(emoji: string): boolean;
export function isCancelEmoji(emoji: string): boolean;
export function isEscapeEmoji(emoji: string): boolean;
```

**Changes Required:**
1. Create `src/mattermost/emoji.ts`
2. Update `session.ts` to use helpers instead of inline checks
3. Update `permission-server.ts` to use helpers
4. Remove `REACTION_EMOJIS` constant from session.ts (use NUMBER_EMOJIS)

**Files Affected:**
- `src/mattermost/emoji.ts` (new)
- `src/claude/session.ts` (simplify checks)
- `src/mcp/permission-server.ts` (simplify checks)

**Lines Eliminated:** ~30

---

#### 2.2 Extract Post Creation Helper

**Problem:** The pattern "create post → add reaction options" appears 4+ times:
- `permission-server.ts:273-278`
- `session.ts:624-635` (plan approval)
- `session.ts:799-812` (question reactions)
- `session.ts:1910-1931` (message approval)

**Current State:**
```typescript
// Repeated pattern:
const post = await createPost(message, threadId);
await addReaction(post.id, '+1');
await addReaction(post.id, '-1');
// ... error handling ...
```

**Solution:** Add helper method to `MattermostClient` or create a builder.

**Addition to:** `src/mattermost/client.ts`
```typescript
/**
 * Create a post and add reaction options for user interaction
 */
async createInteractivePost(
  message: string,
  threadId: string,
  reactions: string[]
): Promise<Post> {
  const post = await this.createPost(message, threadId);
  for (const emoji of reactions) {
    try {
      await this.addReaction(post.id, emoji);
    } catch (err) {
      console.error(`  ⚠️ Failed to add reaction ${emoji}:`, err);
    }
  }
  return post;
}
```

**Changes Required:**
1. Add `createInteractivePost()` to `MattermostClient`
2. Refactor session.ts plan approval to use it
3. Refactor session.ts question handling to use it
4. Refactor session.ts message approval to use it
5. Permission server can use the standalone API version

**Files Affected:**
- `src/mattermost/client.ts` (add method)
- `src/claude/session.ts` (use new method)
- `src/mattermost/api.ts` (add standalone function for permission-server)

**Lines Eliminated:** ~40

---

### Phase 3: Low Impact Cleanup

#### 3.1 Standardize Debug Logging

**Problem:** Different logging implementations:
- `permission-server.ts:53-55` - uses `console.error` with `[MCP]` prefix
- `client.ts:49-51` - uses `console.log` with `[ws]` prefix

**Solution:** Create a simple logger utility.

**New File:** `src/utils/logger.ts`
```typescript
export function createLogger(prefix: string, useStderr = false) {
  return {
    debug: (msg: string) => {
      if (process.env.DEBUG === '1') {
        const log = useStderr ? console.error : console.log;
        log(`${prefix} ${msg}`);
      }
    },
    info: (msg: string) => { /* ... */ },
    error: (msg: string) => { /* ... */ },
  };
}

// Pre-configured loggers
export const mcpLogger = createLogger('[MCP]', true);
export const wsLogger = createLogger('[ws]', false);
```

**Files Affected:**
- `src/utils/logger.ts` (new)
- `src/mcp/permission-server.ts` (use mcpLogger)
- `src/mattermost/client.ts` (use wsLogger)

**Lines Eliminated:** ~10

---

#### 3.2 Extract User Authorization Check

**Problem:** Identical `isUserAllowed()` function in two places:
- `permission-server.ts:90-93`
- `client.ts:319-325`

**Solution:** Add to shared utilities or mattermost/api.ts

**Addition to:** `src/mattermost/api.ts`
```typescript
export function isUserAllowed(username: string, allowList: string[]): boolean {
  if (allowList.length === 0) return true;
  return allowList.includes(username);
}
```

**Files Affected:**
- `src/mattermost/api.ts` (add function)
- `src/mcp/permission-server.ts` (import)
- `src/mattermost/client.ts` (import)

**Lines Eliminated:** ~10

---

## Implementation Order

```
Phase 0 (Foundation - DO FIRST):
  0.1 Set up test infrastructure       → Vitest + mocking
  0.2 Write tests for existing code    → Cover code being refactored
  0.3 Achieve target coverage          → ~80% on refactored modules

Phase 1 (High Impact):
  1.1 Extract Mattermost API Layer     → ~70 lines saved
  1.2 Extract Tool Formatter           → ~100 lines saved

Phase 2 (Medium Impact):
  2.1 Create Emoji Constants           → ~30 lines saved
  2.2 Extract Post Creation Helper     → ~40 lines saved

Phase 3 (Low Impact):
  3.1 Standardize Logging              → ~10 lines saved
  3.2 Extract User Auth Check          → ~10 lines saved

Total: ~260 lines eliminated
```

---

## Phase 0: Test Infrastructure (DO FIRST)

### 0.1 Set Up Test Framework

**Install Dependencies:**
```bash
npm install -D vitest @vitest/coverage-v8
```

**Add to `package.json`:**
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

**Create `vitest.config.ts`:**
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/onboarding.ts'],
    },
  },
});
```

### 0.2 Write Tests for Code Being Refactored

Focus on testing the **current behavior** before modifying. Priority order:

#### A. Tool Formatting Tests (`src/claude/__tests__/tool-formatter.test.ts`)

Test the current `formatToolUse()` logic in session.ts:

```typescript
describe('formatToolUse', () => {
  it('formats Read tool correctly', () => {
    const result = formatToolUse('Read', { file_path: '/path/to/file.ts' });
    expect(result).toContain('📄');
    expect(result).toContain('Read');
    expect(result).toContain('file.ts');
  });

  it('formats Write tool correctly', () => {
    const result = formatToolUse('Write', {
      file_path: '/path/to/new.ts',
      content: 'hello world'
    });
    expect(result).toContain('📝');
    expect(result).toContain('Write');
  });

  it('formats Bash tool and truncates long commands', () => {
    const longCmd = 'x'.repeat(100);
    const result = formatToolUse('Bash', { command: longCmd });
    expect(result).toContain('💻');
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(150);
  });

  it('formats MCP tools correctly', () => {
    const result = formatToolUse('mcp__server__tool', { arg: 'value' });
    expect(result).toContain('server');
    expect(result).toContain('tool');
  });

  it('returns null for unknown tools', () => {
    const result = formatToolUse('UnknownTool', {});
    expect(result).toBeNull();
  });
});
```

#### B. Emoji Helper Tests (`src/mattermost/__tests__/emoji.test.ts`)

Test current emoji checking logic:

```typescript
describe('emoji helpers', () => {
  describe('isApprovalEmoji', () => {
    it('returns true for +1', () => {
      expect(isApprovalEmoji('+1')).toBe(true);
    });
    it('returns true for thumbsup', () => {
      expect(isApprovalEmoji('thumbsup')).toBe(true);
    });
    it('returns false for other emojis', () => {
      expect(isApprovalEmoji('heart')).toBe(false);
    });
  });

  describe('isDenialEmoji', () => {
    it('returns true for -1', () => {
      expect(isDenialEmoji('-1')).toBe(true);
    });
    it('returns true for thumbsdown', () => {
      expect(isDenialEmoji('thumbsdown')).toBe(true);
    });
  });

  describe('isAllowAllEmoji', () => {
    it('returns true for white_check_mark', () => {
      expect(isAllowAllEmoji('white_check_mark')).toBe(true);
    });
    it('returns true for heavy_check_mark', () => {
      expect(isAllowAllEmoji('heavy_check_mark')).toBe(true);
    });
  });
});
```

#### C. Mattermost API Tests (`src/mattermost/__tests__/api.test.ts`)

Test API layer with mocked fetch:

```typescript
import { vi } from 'vitest';

describe('mattermostApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await mattermostApi(
      { url: 'https://mm.test', token: 'secret' },
      'GET',
      '/users/me'
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://mm.test/api/v4/users/me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
        }),
      })
    );
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    }));

    await expect(
      mattermostApi({ url: 'https://mm.test', token: 'bad' }, 'GET', '/users/me')
    ).rejects.toThrow('401');
  });
});
```

#### D. User Authorization Tests

```typescript
describe('isUserAllowed', () => {
  it('returns true when allowlist is empty', () => {
    expect(isUserAllowed('anyone', [])).toBe(true);
  });

  it('returns true when user is in allowlist', () => {
    expect(isUserAllowed('alice', ['alice', 'bob'])).toBe(true);
  });

  it('returns false when user is not in allowlist', () => {
    expect(isUserAllowed('eve', ['alice', 'bob'])).toBe(false);
  });
});
```

### 0.3 Coverage Targets

Before proceeding with refactoring, achieve:

| Module | Target Coverage |
|--------|----------------|
| Tool formatting logic | 90% |
| Emoji helpers | 100% |
| Mattermost API layer | 80% |
| User authorization | 100% |

**Run coverage check:**
```bash
npm run test:coverage
```

### 0.4 Test Directory Structure

```
src/
├── claude/
│   ├── __tests__/
│   │   ├── tool-formatter.test.ts
│   │   └── session.test.ts
│   ├── cli.ts
│   ├── session.ts
│   └── types.ts
├── mattermost/
│   ├── __tests__/
│   │   ├── api.test.ts
│   │   ├── emoji.test.ts
│   │   └── client.test.ts
│   ├── api.ts
│   ├── client.ts
│   └── ...
└── utils/
    └── __tests__/
        └── logger.test.ts
```

### Why Vitest?

- **Fast** - Uses Vite's transform pipeline, very quick startup
- **ESM Native** - Works great with `"type": "module"` projects
- **Jest Compatible** - Familiar API if you know Jest
- **Built-in Coverage** - No additional packages needed for coverage
- **TypeScript** - Works with TypeScript out of the box

---

## New File Structure

After refactoring:

```
src/
├── claude/
│   ├── cli.ts
│   ├── session.ts          # Uses tool-formatter, emoji helpers
│   └── types.ts
├── mattermost/
│   ├── api.ts              # NEW: Shared REST API layer
│   ├── client.ts           # Refactored to use api.ts
│   ├── emoji.ts            # NEW: Emoji constants and helpers
│   ├── message-formatter.ts
│   └── types.ts
├── mcp/
│   └── permission-server.ts # Uses api.ts, tool-formatter, emoji.ts
├── persistence/
│   └── session-store.ts
├── utils/
│   ├── logger.ts           # NEW: Standardized logging
│   └── tool-formatter.ts   # NEW: Shared tool formatting
├── config.ts
├── index.ts
└── onboarding.ts
```

---

## Testing Strategy

### Before Each Refactoring Phase

1. **Ensure tests pass:** `npm test` must pass
2. **Check coverage:** `npm run test:coverage` for modules being changed

### After Each Phase

1. **Build check:** `npm run build` must pass
2. **Run tests:** `npm test` - all tests must pass
3. **Smoke test:** Start bot, create session, test permission prompts
4. **Manual verification:**
   - Permission prompts still appear in thread
   - Reactions still trigger approve/deny
   - Tool formatting displays correctly
   - Plan approval works
   - Question answering works
   - Message approval for non-allowed users works

### Test-Driven Refactoring Workflow

For each extraction:

1. **Write tests first** for the current behavior (characterization tests)
2. **Extract** the code to the new location
3. **Run tests** - they should still pass
4. **Update imports** in consuming files
5. **Run tests again** - verify nothing broke
6. **Remove old code** once new code is working

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Permission server uses different env vars | High | Pass config explicitly, don't rely on env parsing |
| Breaking WebSocket reconnection | Medium | Keep client.ts WebSocket logic unchanged |
| MCP server runs in subprocess | Medium | Ensure shared code doesn't require main process context |
| Type mismatches | Low | Add explicit types to shared functions |

---

## Notes

- The permission MCP server runs as a **subprocess** spawned by Claude CLI, so it cannot directly share class instances with the main bot. Shared code must be pure functions or stateless utilities.
- The `--mcp-config` passes the Mattermost URL/token to the permission server via environment, so the shared API layer needs to accept config as parameters, not read from global state.
- Consider keeping the permission server self-contained enough to work independently, while still sharing utilities.
