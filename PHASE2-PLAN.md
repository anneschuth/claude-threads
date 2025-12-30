# Phase 2: Refactor Mattermost to Implement PlatformClient

## Changes Required

### 1. Move MattermostClient
- FROM: `src/mattermost/client.ts`
- TO: `src/platform/mattermost/client.ts`

### 2. Update MattermostClient to Implement PlatformClient

**Add properties:**
```typescript
readonly platformId: string;
readonly platformType = 'mattermost' as const;
readonly displayName: string;
```

**Update constructor:**
```typescript
// OLD: constructor(config: Config)
// NEW: constructor(platformConfig: MattermostPlatformConfig)
```

**Add type normalization:**
- `getBotUser()`: return `PlatformUser` instead of `MattermostUser`
- `getUser()`: return `PlatformUser | null`
- `createPost()`: return `PlatformPost`
- etc.

### 3. Create MattermostFormatter

Create `src/platform/mattermost/formatter.ts` implementing `PlatformFormatter`

### 4. Backward Compatibility

Keep `src/mattermost/client.ts` as re-export:
```typescript
export { MattermostClient } from '../platform/mattermost/client.js';
export type * from '../platform/mattermost/types.js';
```

### 5. Move Mattermost Types

- FROM: `src/mattermost/types.ts`
- TO: `src/platform/mattermost/types.ts`

## Testing Strategy

- Build TypeScript (ensure no compilation errors)
- Existing code should still work (backward compat via re-exports)
- Ready for Phase 4 (SessionManager refactor)
