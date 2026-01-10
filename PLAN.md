# Implementation Plan: Auto-Generated Session Titles & Tags

## Overview

Two new features using `quickQuery` to enhance session metadata:

1. **Auto-generate Session Title/Description** - Fire a parallel Haiku query at session start instead of relying on Claude's first response
2. **Session Tagging** - Automatically classify sessions with tags (bug-fix, feature, refactor, etc.)

Both use the same pattern as `branch-suggest.ts`: fast Haiku queries with silent fallback.

---

## Feature 1: Auto-Generate Session Title/Description

### Current Behavior
- System prompt instructs Claude to output `[SESSION_TITLE: ...]` and `[SESSION_DESCRIPTION: ...]` at start of first response
- Parsed in `events.ts` via `extractAndUpdateMetadata()`
- Adds latency to first response (Claude has to think about title + actual task)
- Sometimes Claude forgets or outputs poor titles

### New Behavior
- Fire `quickQuery` in parallel with session start
- Pre-populate `sessionTitle` and `sessionDescription` before Claude responds
- If quickQuery fails, fall back to current behavior (Claude still gets the instruction)
- If quickQuery succeeds, Claude's markers are ignored (already have better title)

### Implementation Steps

#### Step 1: Create `src/session/title-suggest.ts`
New module following `branch-suggest.ts` pattern:

```typescript
// src/session/title-suggest.ts
import { quickQuery } from '../claude/quick-query.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('title-suggest');
const SUGGESTION_TIMEOUT = 3000; // Faster than branch suggest

interface SessionMetadata {
  title: string;      // 3-7 words, imperative form
  description: string; // 1-2 sentences, under 100 chars
}

export function buildTitlePrompt(userMessage: string): string {
  return `Generate a session title and description for this task.

Task: "${userMessage}"

Rules for title:
- 3-7 words, imperative form (e.g., "Fix login bug", "Add dark mode")
- No quotes or punctuation at end
- Capture the main intent

Rules for description:
- 1-2 sentences, under 100 characters
- Explain what will be accomplished

Output format (exactly):
TITLE: <title here>
DESC: <description here>`;
}

export function parseMetadata(response: string): SessionMetadata | null {
  const titleMatch = response.match(/TITLE:\s*(.+)/i);
  const descMatch = response.match(/DESC:\s*(.+)/i);

  if (!titleMatch || !descMatch) return null;

  const title = titleMatch[1].trim();
  const description = descMatch[1].trim();

  // Validate
  if (title.length < 3 || title.length > 50) return null;
  if (description.length < 5 || description.length > 100) return null;

  return { title, description };
}

export async function suggestSessionMetadata(
  userMessage: string
): Promise<SessionMetadata | null> {
  log.debug(`Suggesting title for: "${userMessage.substring(0, 50)}..."`);

  try {
    const result = await quickQuery({
      prompt: buildTitlePrompt(userMessage),
      model: 'haiku',
      timeout: SUGGESTION_TIMEOUT,
    });

    if (!result.success || !result.response) {
      log.debug(`Title suggestion failed: ${result.error || 'no response'}`);
      return null;
    }

    const metadata = parseMetadata(result.response);
    if (metadata) {
      log.debug(`Got title: "${metadata.title}"`);
    }
    return metadata;
  } catch (err) {
    log.debug(`Title suggestion error: ${err}`);
    return null;
  }
}
```

#### Step 2: Integrate in `src/session/lifecycle.ts`

In `startSession()`, fire quickQuery in parallel:

```typescript
// In startSession(), after creating session but before starting Claude CLI

// Fire title suggestion in background (don't await)
suggestSessionMetadata(message).then(metadata => {
  if (metadata && !session.sessionTitle) {
    session.sessionTitle = metadata.title;
    session.sessionDescription = metadata.description;
    ctx.ops.persistSession(session);
    // Update sticky message and header
    ctx.updateStickyMessage?.();
    updateSessionHeader(ctx, session);
  }
});
```

#### Step 3: Modify `events.ts` metadata extraction

Skip title extraction if already populated by quickQuery:

```typescript
// In formatEvent(), line ~388
if (!session.sessionTitle) {
  extractAndUpdateMetadata(session, messageText, titleMetadataConfig, ...);
}
if (!session.sessionDescription) {
  extractAndUpdateMetadata(session, messageText, descriptionMetadataConfig, ...);
}
```

#### Step 4: Update system prompt (optional)

Could remove `SESSION_TITLE`/`SESSION_DESCRIPTION` instructions from `CHAT_PLATFORM_PROMPT` since quickQuery handles it. Or keep as fallback.

### Testing

1. Unit tests for `buildTitlePrompt()` and `parseMetadata()`
2. Integration test: start session, verify title appears quickly
3. Fallback test: mock quickQuery failure, verify Claude's title still works

---

## Feature 2: Session Tagging

### New Behavior
- Automatically classify sessions with 1-3 tags
- Tags: `bug-fix`, `feature`, `refactor`, `docs`, `test`, `config`, `security`, `performance`, `exploration`
- Displayed in sticky message and session header
- Stored in session metadata for future search/filtering

### Implementation Steps

#### Step 1: Add tags to types

**`src/session/types.ts`:**
```typescript
// After sessionDescription field (~line 237)
sessionTags?: string[];  // Auto-generated classification tags
```

**`src/persistence/session-store.ts`:**
```typescript
// In PersistedSession interface
sessionTags?: string[];
```

**`src/ui/types.ts`:**
```typescript
// In SessionInfo interface
tags?: string[];
```

#### Step 2: Create `src/session/tag-suggest.ts`

```typescript
// src/session/tag-suggest.ts
import { quickQuery } from '../claude/quick-query.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tag-suggest');
const SUGGESTION_TIMEOUT = 2000;

const VALID_TAGS = [
  'bug-fix', 'feature', 'refactor', 'docs', 'test',
  'config', 'security', 'performance', 'exploration', 'cleanup'
] as const;

export type SessionTag = typeof VALID_TAGS[number];

export function buildTagPrompt(userMessage: string): string {
  return `Classify this task with 1-3 tags from this list ONLY:
${VALID_TAGS.join(', ')}

Task: "${userMessage}"

Output ONLY the tags, comma-separated, nothing else.`;
}

export function parseTags(response: string): SessionTag[] {
  const tags = response
    .toLowerCase()
    .split(/[,\n]/)
    .map(t => t.trim())
    .filter((t): t is SessionTag => VALID_TAGS.includes(t as SessionTag));

  return [...new Set(tags)].slice(0, 3); // Dedupe, max 3
}

export async function suggestSessionTags(
  userMessage: string
): Promise<SessionTag[]> {
  log.debug(`Suggesting tags for: "${userMessage.substring(0, 50)}..."`);

  try {
    const result = await quickQuery({
      prompt: buildTagPrompt(userMessage),
      model: 'haiku',
      timeout: SUGGESTION_TIMEOUT,
    });

    if (!result.success || !result.response) {
      log.debug(`Tag suggestion failed: ${result.error || 'no response'}`);
      return [];
    }

    const tags = parseTags(result.response);
    log.debug(`Got tags: ${tags.join(', ')}`);
    return tags;
  } catch (err) {
    log.debug(`Tag suggestion error: ${err}`);
    return [];
  }
}
```

#### Step 3: Integrate in `src/session/lifecycle.ts`

Combine with title suggestion for efficiency:

```typescript
// In startSession(), fire both in parallel
Promise.all([
  suggestSessionMetadata(message),
  suggestSessionTags(message),
]).then(([metadata, tags]) => {
  let updated = false;

  if (metadata && !session.sessionTitle) {
    session.sessionTitle = metadata.title;
    session.sessionDescription = metadata.description;
    updated = true;
  }

  if (tags.length > 0 && !session.sessionTags?.length) {
    session.sessionTags = tags;
    updated = true;
  }

  if (updated) {
    ctx.ops.persistSession(session);
    ctx.updateStickyMessage?.();
    updateSessionHeader(ctx, session);
  }
});
```

#### Step 4: Display tags in UI

**`src/session/sticky-message.ts`** - Add tag badges:
```typescript
// In formatActiveSession(), after topic line
if (session.sessionTags?.length) {
  const tagBadges = session.sessionTags.map(t => `\`${t}\``).join(' ');
  parts.push(tagBadges);
}
```

**`src/session/commands.ts`** - Add to session header:
```typescript
// In updateSessionHeader(), add row for tags
if (session.sessionTags?.length) {
  items.push({
    emoji: '🏷️',
    label: 'Tags',
    value: session.sessionTags.map(t => `\`${t}\``).join(' '),
  });
}
```

#### Step 5: Persistence migration

In `session-store.ts`, handle missing tags field:
```typescript
// In loadSessions(), when restoring
sessionTags: state.sessionTags || [],
```

### Testing

1. Unit tests for `buildTagPrompt()` and `parseTags()`
2. Integration test: start session, verify tags appear
3. Verify tags persist across restart
4. Verify tags display in sticky message and header

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src/session/title-suggest.ts` | **NEW** - Title/description suggestion |
| `src/session/tag-suggest.ts` | **NEW** - Tag classification |
| `src/session/lifecycle.ts` | Fire quickQuery at session start |
| `src/session/events.ts` | Skip extraction if already populated |
| `src/session/types.ts` | Add `sessionTags` field |
| `src/persistence/session-store.ts` | Add `sessionTags` to persistence |
| `src/ui/types.ts` | Add `tags` to SessionInfo |
| `src/session/sticky-message.ts` | Display tags in active/history |
| `src/session/commands.ts` | Display tags in session header |
| `src/session/index.ts` | Export new modules |

---

## Estimated Effort

- **Feature 1 (Title)**: ~2 hours
- **Feature 2 (Tags)**: ~1.5 hours
- **Testing**: ~1 hour
- **Total**: ~4.5 hours

---

## Design Decisions (Confirmed)

1. **Title/tags update as session progresses** ✅
   - Re-run quickQuery periodically if session focus shifts
   - Trigger: After significant messages (every N messages, or when topic seems to change)

2. **Manual tag editing** - Deferred
   - Future enhancement: `!tag add/remove` commands

3. **Remove SESSION_TITLE system prompt** ✅
   - quickQuery handles title generation out-of-band
   - No need for Claude to waste tokens on metadata in responses

4. **Completely out-of-band execution** ✅
   - Fire quickQuery at session start, don't block anything
   - Update UI asynchronously when results arrive
   - Main Claude session proceeds immediately
