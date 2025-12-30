# Phase 2 TODO: Complete Mattermost Client Refactor

## Status
✅ Phase 1 Complete (platform interfaces)
🔄 Phase 2 In Progress (Mattermost refactor)

## Completed
- ✅ Created platform abstraction layer (interfaces + types)
- ✅ Copied Mattermost types to `src/platform/mattermost/types.ts`
- ✅ Created `MattermostFormatter` implementing `PlatformFormatter`
- ✅ Copied `MattermostClient` to `src/platform/mattermost/client.ts`

## Remaining Work

### 1. Update `src/platform/mattermost/client.ts`

**Import changes** (lines 1-14):
```typescript
// CHANGE:
import type { Config } from '../config.js';
// TO:
import type { MattermostPlatformConfig } from '../../config/migration.js';

// ADD these imports:
import type {
  PlatformClient,
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
} from '../index.js';
```

**Class declaration** (line 29):
```typescript
// CHANGE:
export class MattermostClient extends EventEmitter {
// TO:
export class MattermostClient extends EventEmitter implements PlatformClient {
```

**Add platform identity properties** (after line 36):
```typescript
// Platform identity (required by PlatformClient interface)
readonly platformId: string;
readonly platformType = 'mattermost' as const;
readonly displayName: string;
```

**Update constructor** (lines 44-47):
```typescript
// CHANGE:
constructor(config: Config) {
  super();
  this.config = config;
}
// TO:
constructor(platformConfig: MattermostPlatformConfig) {
  super();
  this.platformId = platformConfig.id;
  this.displayName = platformConfig.displayName;

  // Convert platform config to legacy format for internal use
  this.config = {
    mattermost: {
      url: platformConfig.url,
      token: platformConfig.token,
      channelId: platformConfig.channelId,
      botName: platformConfig.botName,
    },
    allowedUsers: platformConfig.allowedUsers,
    skipPermissions: platformConfig.skipPermissions,
    chrome: false, // Not used in client
    worktreeMode: 'prompt', // Not used in client
  };
}
```

**Add type normalization helpers** (after constructor):
```typescript
// Normalize Mattermost types to Platform types
private normalizePlatformUser(mattermostUser: MattermostUser): PlatformUser {
  return {
    id: mattermostUser.id,
    username: mattermostUser.username,
    email: mattermostUser.email,
  };
}

private normalizePlatformPost(mattermostPost: MattermostPost): PlatformPost {
  return {
    id: mattermostPost.id,
    platformId: this.platformId,
    channelId: mattermostPost.channel_id,
    userId: mattermostPost.user_id,
    message: mattermostPost.message,
    rootId: mattermostPost.root_id,
    createAt: mattermostPost.create_at,
    metadata: mattermostPost.metadata,
  };
}

private normalizePlatformReaction(mattermostReaction: MattermostReaction): PlatformReaction {
  return {
    userId: mattermostReaction.user_id,
    postId: mattermostReaction.post_id,
    emojiName: mattermostReaction.emoji_name,
    createAt: mattermostReaction.create_at,
  };
}

private normalizePlatformFile(mattermostFile: MattermostFile): PlatformFile {
  return {
    id: mattermostFile.id,
    name: mattermostFile.name,
    size: mattermostFile.size,
    mimeType: mattermostFile.mime_type,
    extension: mattermostFile.extension,
  };
}
```

**Update method return types** to use Platform* types:
- `getBotUser()`: Return `PlatformUser` (line 74)
- `getUser()`: Return `PlatformUser | null` (line 81)
- `createPost()`: Return `PlatformPost` (line 95)
- `updatePost()`: Return `PlatformPost` (line 108)
- `createInteractivePost()`: Return `PlatformPost` (line 136)
- `getFileInfo()`: Return `PlatformFile` (line 173)
- `getPost()`: Return `PlatformPost | null` (line 178)

**Update event emissions** (lines 265-267, 286-288):
```typescript
// CHANGE:
this.emit('message', post, user);
// TO:
this.emit('message', this.normalizePlatformPost(post), user ? this.normalizePlatformUser(user) : null);

// CHANGE:
this.emit('reaction', reaction, user);
// TO:
this.emit('reaction', this.normalizePlatformReaction(reaction), user ? this.normalizePlatformUser(user) : null);
```

### 2. Create backward compatibility wrapper

Create `src/mattermost/client.ts`:
```typescript
/**
 * Backward compatibility wrapper
 * Re-exports MattermostClient from new location
 */
import { MattermostClient as PlatformMattermostClient } from '../platform/mattermost/client.js';
import type { Config } from '../config.js';

/**
 * Legacy MattermostClient wrapper
 * Converts old Config format to new platform config
 */
export class MattermostClient extends PlatformMattermostClient {
  constructor(config: Config) {
    // Convert legacy Config to MattermostPlatformConfig
    super({
      id: 'default',
      type: 'mattermost',
      displayName: 'Mattermost',
      url: config.mattermost.url,
      token: config.mattermost.token,
      channelId: config.mattermost.channelId,
      botName: config.mattermost.botName,
      allowedUsers: config.allowedUsers,
      skipPermissions: config.skipPermissions,
    });
  }
}

// Re-export types for backward compat
export type * from '../platform/mattermost/types.js';
```

### 3. Update `src/mattermost/types.ts`
```typescript
/**
 * Backward compatibility wrapper
 * Re-exports Mattermost types from new location
 */
export type * from '../platform/mattermost/types.js';
```

### 4. Test compilation
```bash
npm run build
```

Should compile without errors. Existing code should work unchanged.

## Testing Checklist
- [ ] TypeScript compiles (`npm run build`)
- [ ] Existing bot still connects to Mattermost
- [ ] Messages are received and processed
- [ ] Reactions work
- [ ] File uploads work
- [ ] Session management works

## Next Phase
After Phase 2 complete → Phase 4: Update SessionManager to be platform-agnostic
