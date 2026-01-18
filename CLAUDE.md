# Claude Code Instructions for claude-threads

## What This Project Does

This is a multi-platform bot that lets users interact with Claude Code through chat platforms. When someone @mentions the bot in a channel, it spawns a Claude Code CLI session in a configured working directory and streams all output to a thread. The user can continue the conversation by replying in the thread.

**Currently Supported Platforms:**
- Mattermost (full support)
- Slack (full support)

**Key Features:**
- Real-time streaming of Claude responses to chat platforms
- **Multi-platform support** - connect to multiple Mattermost/Slack instances simultaneously
- **Multiple concurrent sessions** - one per thread, across all platforms
- **Session persistence** - sessions resume automatically after bot restart
- **Session collaboration** - `!invite @user` to temporarily allow users in a session
- **Message approval** - unauthorized users can request approval for their messages
- **Thread context prompt** - when starting a session mid-thread, offers to include previous conversation context
- Interactive permission approval via emoji reactions
- Plan approval and question answering via reactions
- Task list display with live updates
- Code diffs and file previews
- Multi-user access control
- Automatic idle session cleanup

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Chat Platform                               │
│  ┌──────────────┐                    ┌──────────────────────┐   │
│  │ User message │ ───WebSocket───▶  │   PlatformClient     │   │
│  │ + reactions  │ ◀───────────────  │   (Mattermost/Slack) │   │
│  └──────────────┘                    └──────────┬───────────┘   │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │
                      ┌───────────────────────────┴────────────────┐
                      │              SessionManager                 │
                      │  - Orchestrates session lifecycle           │
                      │  - Delegates to specialized modules         │
                      │  - sessions: Map<sessionId, Session>        │
                      │  - postIndex: Map<postId, threadId>         │
                      └───────────────────────────┬────────────────┘
                                                  │
                              ┌───────────────────┼───────────────────┐
                              │                   │                   │
                              ▼                   ▼                   ▼
                      ┌───────────┐       ┌───────────┐       ┌───────────┐
                      │  Session  │       │  Session  │       │  Session  │
                      │ (thread1) │       │ (thread2) │       │ (thread3) │
                      └─────┬─────┘       └─────┬─────┘       └─────┬─────┘
                            │                   │                   │
                            ▼                   ▼                   ▼
                      ┌───────────┐       ┌───────────┐       ┌───────────┐
                      │ ClaudeCli │       │ ClaudeCli │       │ ClaudeCli │
                      │ + MCP srv │       │ + MCP srv │       │ + MCP srv │
                      └───────────┘       └───────────┘       └───────────┘
```

**Session contains:**
- `claude: ClaudeCli` - the Claude CLI process
- `claudeSessionId: string` - UUID for session persistence/resume
- `messageManager: MessageManager` - orchestrates all message operations and state
- `sessionAllowedUsers: Set<string>` - per-session allowlist (includes session owner)
- `isResumed: boolean` - whether session was resumed after restart

**MessageManager contains executors that own their state:**
- `ContentExecutor` - content streaming state
- `TaskListExecutor` - task list display state
- `QuestionApprovalExecutor` - pending questions/approvals
- `PromptExecutor` - context prompts, worktree prompts, update prompts
- `SubagentExecutor` - active subagent tracking
- `MessageApprovalExecutor` - unauthorized message approval
- `BugReportExecutor` - bug report flow

**MCP Permission Server:**
- Spawned via `--mcp-config` per Claude CLI instance
- Each has its own WebSocket/connection to the platform
- Posts permission requests to the session's thread
- Returns allow/deny based on user reaction

## Multi-Platform Support

**Architecture**: claude-threads supports connecting to multiple chat platforms simultaneously through a platform abstraction layer.

**Currently Supported**:
- ✅ Mattermost (fully implemented)
- ✅ Slack (fully implemented)

**Key Concepts**:

1. **Platform Abstraction**: `PlatformClient` interface normalizes differences between platforms
2. **Composite Session IDs**: Sessions are identified by `"platformId:threadId"` to ensure uniqueness across platforms
3. **Independent Credentials**: Each platform instance has its own URL, token, and channel configuration
4. **Per-Platform MCP Servers**: Each session's MCP permission server connects to the correct platform

**Configuration**:

Multi-platform mode uses YAML config (`~/.config/claude-threads/config.yaml`):

```yaml
version: 1
workingDir: /home/user/repos/myproject
chrome: false
worktreeMode: prompt

platforms:
  # Mattermost configuration
  - id: mattermost-main
    type: mattermost
    displayName: Main Team
    url: https://chat.example.com
    token: your-bot-token-here
    channelId: abc123
    botName: claude-code
    allowedUsers: [alice, bob]
    skipPermissions: false

  # Slack configuration
  - id: slack-workspace
    type: slack
    displayName: Slack Team
    botToken: xoxb-your-bot-token    # Bot User OAuth Token
    appToken: xapp-your-app-token    # App-Level Token (for Socket Mode)
    channelId: C0123456789
    botName: claude-bot
    allowedUsers: [alice, bob]       # Slack usernames
    skipPermissions: false
```

**Slack-specific notes:**
- Requires both a Bot Token (`xoxb-`) and App Token (`xapp-`) for Socket Mode
- `allowedUsers` uses Slack usernames (not user IDs) for consistency with Mattermost
- User mentions in messages use Slack user IDs (e.g., `<@U0123ALICE>`) - the bot handles this automatically
- Bot Token scopes required: `channels:history`, `channels:read`, `chat:write`, `files:read`, `reactions:read`, `reactions:write`, `users:read`
- App Token scope: `connections:write` (Socket Mode must be enabled in the Slack app)

Configuration is stored in YAML only - no `.env` file support.

## Source Files

### Core
| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point. CLI parsing, bot startup, UI rendering |
| `src/message-handler.ts` | Message routing logic (extracted for testability) |
| `src/config.ts` | Type exports for config (re-exports from migration.ts) |
| `src/config/migration.ts` | YAML config loading (`config.yaml`) |
| `src/onboarding.ts` | Interactive setup wizard for multi-platform config |

### Session Management

Session is a thin container; most logic lives in `src/operations/`:

| File | Purpose |
|------|---------|
| `src/session/manager.ts` | **Orchestrator** - creates sessions, routes messages/reactions |
| `src/session/lifecycle.ts` | Session start, resume, exit, cleanup |
| `src/session/types.ts` | TypeScript types (Session interface) |
| `src/session/registry.ts` | Session lookup and registration |
| `src/session/timer-manager.ts` | Per-session timer management |
| `src/session/index.ts` | Public exports |

### Operations Layer (The Brain)

Most business logic lives in `src/operations/`:

| File | Purpose |
|------|---------|
| `src/operations/message-manager.ts` | **The Brain** - orchestrates all operations via executors |
| `src/operations/transformer.ts` | Transforms Claude events → MessageOperations |
| `src/operations/types.ts` | Operation types (MessageOperation, TaskItem, etc.) |
| `src/operations/post-helpers/` | DRY utilities for posting messages (postInfo, postError, etc.) |
| `src/operations/events/handler.ts` | Claude CLI event handling |
| `src/operations/commands/handler.ts` | User commands (!cd, !invite, !kick, !permissions) |
| `src/operations/streaming/handler.ts` | Message batching and flushing to chat |
| `src/operations/context-prompt/handler.ts` | Thread context prompt for mid-thread session starts |
| `src/operations/worktree/handler.ts` | Git worktree management |
| `src/operations/bug-report/handler.ts` | Bug report flow |
| `src/operations/sticky-message/handler.ts` | Channel sticky message |
| `src/operations/tool-formatters/` | Format tool use for display |

### Executors (State Owners)

Each executor owns a specific piece of interactive state:

| File | Purpose |
|------|---------|
| `src/operations/executors/content.ts` | Content streaming state |
| `src/operations/executors/task-list.ts` | Task list display |
| `src/operations/executors/question-approval.ts` | Questions and plan approval |
| `src/operations/executors/prompt.ts` | Context prompts, worktree prompts, update prompts |
| `src/operations/executors/subagent.ts` | Subagent tracking |
| `src/operations/executors/message-approval.ts` | Unauthorized message approval |
| `src/operations/executors/bug-report.ts` | Bug report flow |
| `src/operations/executors/system.ts` | System messages |
| `src/operations/executors/worktree-prompt.ts` | Worktree prompts |

**Design Pattern**: MessageManager delegates to executors. Each executor owns its state and handles its reactions. This keeps Session minimal while centralizing all message operations.

### Claude CLI
| File | Purpose |
|------|---------|
| `src/claude/cli.ts` | Spawns Claude CLI with platform-specific MCP config |
| `src/claude/types.ts` | TypeScript types for Claude stream-json events |
| `src/claude/version-check.ts` | Claude CLI version validation and compatibility check |

### Platform Layer
| File | Purpose |
|------|---------|
| `src/platform/client.ts` | PlatformClient interface (abstraction for all platforms) |
| `src/platform/types.ts` | Normalized types (PlatformPost, PlatformUser, PlatformReaction, etc.) |
| `src/platform/formatter.ts` | PlatformFormatter interface (markdown dialects) |
| `src/platform/utils.ts` | **NEW** - Platform-agnostic utilities (message splitting, emoji normalization, retry logic) |
| `src/platform/IMPLEMENTATION_GUIDE.md` | **NEW** - Guide for implementing new platform support |
| `src/platform/index.ts` | Public exports |
| `src/platform/mattermost/client.ts` | Mattermost implementation of PlatformClient |
| `src/platform/mattermost/types.ts` | Mattermost-specific types |
| `src/platform/mattermost/formatter.ts` | Mattermost markdown formatter |
| `src/platform/slack/client.ts` | Slack implementation of PlatformClient (Socket Mode + Web API) |
| `src/platform/slack/types.ts` | Slack-specific types |
| `src/platform/slack/formatter.ts` | Slack mrkdwn formatter |
| `src/platform/slack/permission-api.ts` | Slack permission API for MCP server |
| `src/platform/slack/index.ts` | Slack module exports |

### Utilities
| File | Purpose |
|------|---------|
| `src/utils/emoji.ts` | Emoji constants and validators (platform-agnostic) |
| `src/utils/logger.ts` | Component-based logging with session context |
| `src/utils/session-log.ts` | Session-aware logging utilities |
| `src/utils/format.ts` | ID formatting, time/duration formatting |
| `src/utils/colors.ts` | Terminal color utilities |
| `src/utils/keep-alive.ts` | Prevent system sleep during sessions |
| `src/utils/battery.ts` | Battery status monitoring |
| `src/utils/uptime.ts` | Session uptime tracking |
| `src/utils/pr-detector.ts` | Detect PR URLs in Claude output |
| `src/mcp/permission-server.ts` | MCP server for permission prompts (platform-agnostic) |
| `src/platform/permission-api-factory.ts` | Factory for platform-specific permission APIs |
| `src/platform/permission-api.ts` | PermissionApi interface |
| `src/mattermost/api.ts` | Standalone Mattermost API helpers |
| `src/persistence/session-store.ts` | Multi-platform session persistence |
| `src/logo.ts` | ASCII art logo |

## How the Permission System Works

1. **Claude CLI is started with:**
   ```
   claude --input-format stream-json --output-format stream-json --verbose \
     --mcp-config '{"mcpServers":{"claude-threads-permissions":{...}}}' \
     --permission-prompt-tool mcp__claude-threads-permissions__permission_prompt
   ```

2. **When Claude needs permission** (e.g., to write a file), it calls the MCP tool

3. **The MCP server** (running as a subprocess):
   - Receives the permission request via stdio
   - Posts a message to the chat thread: "⚠️ Permission requested: Write `file.txt`"
   - Adds reaction options (👍 ✅ 👎) to the message
   - Opens a WebSocket to the platform and waits for a reaction

4. **User reacts** with an emoji

5. **MCP server**:
   - Validates the user is in ALLOWED_USERS
   - Ignores bot's own reactions (the reaction options)
   - Returns `{behavior: "allow"}` or `{behavior: "deny"}` to Claude CLI

6. **Claude CLI** proceeds or aborts based on the response

## Configuration

Configuration is stored in YAML at `~/.config/claude-threads/config.yaml`.

**First run:** If no config exists, interactive onboarding guides you through setup.

### Environment Variables (Optional)

| Variable | Description |
|----------|-------------|
| `MAX_SESSIONS` | Max concurrent sessions (default: `5`) |
| `SESSION_TIMEOUT_MS` | Idle session timeout in ms (default: `1800000` = 30 min) |
| `DEBUG` | Set `1` for debug logging |
| `CLAUDE_PATH` | Custom path to claude binary (default: `claude`) |

### Claude CLI Version Requirements

claude-threads requires a compatible version of the Claude CLI (`@anthropic-ai/claude-code`).

**Compatible versions:** `>=2.0.74 <=2.0.76`

The version is checked at startup. If an incompatible version is detected:
- The bot will display an error message and exit
- Use `--skip-version-check` to bypass (not recommended)

To install a specific compatible version:
```bash
npm install -g @anthropic-ai/claude-code@2.0.76
```

The Claude CLI version is displayed:
- At bot startup in the terminal
- In the sticky channel message status bar
- In each session's header table

**Updating the version range:** Edit `CLAUDE_CLI_VERSION_RANGE` in `src/claude/version-check.ts` when testing with new Claude CLI versions.

## Development Commands

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript to dist/
bun run dev          # Run from source with watch mode
bun start            # Run compiled version
bun test             # Run unit tests (~1700 tests)
bun run lint         # Run ESLint
```

### Integration Tests

Integration tests run the actual bot against a real Mattermost instance with a mock Claude CLI.

```bash
# Run locally (requires Docker)
bun run test:integration:setup    # Start Mattermost in Docker + create users/channels
bun run test:integration:run      # Run ~120 integration tests
bun run test:integration:teardown # Stop Mattermost

# Or run all at once (CI style)
bun run test:integration
```

**What's tested:**
- Session lifecycle (start, response, end, timeout)
- Commands (!stop, !escape, !help, !cd, !kill, !permissions)
- Reaction-based controls (❌ cancel, ⏸️ interrupt)
- Multi-user collaboration (!invite, !kick, message approval)
- Session persistence and resume
- Plan approval, question flows, context prompts
- Git worktree integration
- Error handling, MAX_SESSIONS limits

**CI:** Integration tests run automatically on PRs via `.github/workflows/integration.yml`

## Testing Locally

1. Create config: `~/.config/claude-threads/config.yaml` (or run `claude-threads` for interactive setup)
2. Build: `bun run build`
3. Run: `bun start` (or `DEBUG=1 bun start` for verbose output)
4. In Mattermost, @mention the bot: `@botname write "hello" to test.txt`
5. Watch the permission prompt appear, react with 👍
6. Verify file was created

## Publishing a New Version

Releases are automated via GitHub Actions. When you create a GitHub release, it automatically publishes to the npm registry.

### Quick Release Flow (with open PRs)

When there are open PRs to merge before releasing:

```bash
# 1. List open PRs and verify checks pass before merging
gh pr list --state open
gh pr checks <PR_NUMBER>  # Ensure all checks pass!

# 2. Merge PRs (squash merge, delete branches)
gh pr merge <PR_NUMBER> --squash --delete-branch
# Repeat for each PR (ignore worktree branch deletion errors)

# 3. Pull merged changes
git pull

# 4. Remove any deprecated files if needed
rm <file> && git add -A

# 5. Update CHANGELOG.md with new version and all merged PR changes
# Use format: **Feature/Fix name** - Description (#PR_NUMBER)

# 6. Commit changelog
git add CHANGELOG.md && git commit -m "Update CHANGELOG for vX.Y.Z"

# 7. Bump version
npm version patch --no-git-tag-version  # 0.47.0 → 0.47.1 (fixes only)
npm version minor --no-git-tag-version  # 0.47.0 → 0.48.0 (new features)
npm version major --no-git-tag-version  # 0.47.0 → 1.0.0 (breaking changes)

# 8. Commit and tag
git add package.json && git commit -m "X.Y.Z" && git tag vX.Y.Z

# 9. Push to GitHub with tags
git push && git push --tags

# 10. Create GitHub release (triggers automatic npm publish)
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

### Manual Release Flow (no PRs to merge)

**IMPORTANT: Always test locally before pushing!**
```bash
# 0. Build and run locally to test
bun run build && bun start
# Test in Mattermost: https://digilab.overheid.nl/chat/digilab/channels/annes-claude-code-sessies
# Kill the server when done testing (Ctrl+C)
```

```bash
# 1. Update CHANGELOG.md with the new version

# 2. Commit the changelog
git add CHANGELOG.md && git commit -m "Update CHANGELOG for vX.Y.Z"

# 3. Bump version
npm version patch --no-git-tag-version  # then commit and tag manually

# 4. Commit and tag
git add package.json && git commit -m "X.Y.Z" && git tag vX.Y.Z

# 5. Push to GitHub with tags
git push && git push --tags

# 6. Create GitHub release (this triggers automatic npm publish)
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

**GitHub Actions Workflow:** `.github/workflows/publish.yml`
- Triggered on: GitHub release published
- Builds TypeScript and publishes to the npm registry
- Requires `NPM_TOKEN` secret in repository settings

**⚠️ IMPORTANT: NEVER modify the workflow trigger!**
- The workflow MUST trigger on `release: types: [published]`
- NEVER change it to trigger on tag pushes
- The user creates releases manually via `gh release create`
- This is the preferred release workflow - do not change it

**Token Setup (already configured):**
- Classic Automation token stored in GitHub repository secrets as `NPM_TOKEN`
- To update: https://github.com/anneschuth/claude-threads/settings/secrets/actions

## Testing Deployed Versions in Mattermost

After deploying a new version, test it in the Mattermost channel:
https://digilab.overheid.nl/chat/digilab/channels/annes-claude-code-sessies

### Basic Verification
1. **Check version**: `@minion-of-anne what version are you running?`
   - Bot should respond with version number and summary of recent changes
   - Verify the session header shows correct version

### Testing Permission System
1. **Start a new session** (existing sessions keep their original permission mode)
2. **Enable interactive permissions**: `!permissions interactive`
   - Should see: "🔐 **Interactive permissions enabled** ... *Claude Code restarted with permission prompts*"
   - Session header should update to show "Permissions: Interactive"
3. **Test permission prompt**: `@minion-of-anne write "test" to /tmp/perm-test.txt`
   - Should see a permission prompt with reaction options: 👍 ✅ 👎
   - React with 👍 to approve
   - File should be written after approval

### Testing Other Features
- **Session collaboration**: `!invite @username` / `!kick @username`
- **Directory change**: `!cd /some/path` (restarts Claude CLI)
- **Interrupt**: `!escape` or ⏸️ reaction (interrupts without killing)
- **Cancel**: `!stop` or ❌/🛑 reaction (kills the session)
- **Plan approval**: When Claude presents a plan, react with 👍/👎
- **Question answering**: When Claude asks questions, react with number emojis

### Verifying Specific Bug Fixes
When testing a specific fix:
1. Reproduce the original bug scenario
2. Verify the fix works as expected
3. Check for regressions in related functionality

## Data Retention & Security

claude-threads stores sensitive session data locally. The following retention policies and security measures apply:

### Data Storage Locations

| Data | Location | Retention | Permissions |
|------|----------|-----------|-------------|
| Session state | `~/.config/claude-threads/sessions.json` | Active + 3 days after soft-delete | `0600` (owner only) |
| Thread logs | `~/.claude-threads/logs/{platformId}/` | 30 days (configurable) | `0600` (owner only) |
| Worktree metadata | `~/.claude-threads/worktrees.json` | Until worktree cleanup | `0600` (owner only) |
| Configuration | `~/.config/claude-threads/config.yaml` | Permanent | `0600` (owner only) |

### Automatic Cleanup

- **Session purge**: Inactive sessions are soft-deleted after session timeout, then permanently removed after 3 days
- **Thread logs**: Automatically deleted after 30 days (configurable via `threadLogs.retentionDays` in config)
- **Worktrees**: Orphaned worktrees (no active session, >24h old) are cleaned up automatically
- **Cleanup scheduler**: Runs hourly in the background

### Security Measures

- All sensitive files use restrictive permissions (`0600` - owner read/write only)
- Session tokens and credentials are never written to disk (config file excluded)
- Permission decisions are logged for audit purposes
- Bot tokens should be stored securely (environment variables or secure config)

## Common Issues & Solutions

### "Permission server not responding"
- Check that `MATTERMOST_URL` and `MATTERMOST_TOKEN` are passed to MCP server
- Look for `[MCP]` prefixed logs in stderr
- Enable `DEBUG=1` for verbose MCP logging

### "Reaction not detected"
- The MCP server has its own WebSocket connection (separate from main bot)
- Check that the reacting user is in `ALLOWED_USERS`
- Bot's own reactions (adding the 👍 ✅ 👎 options) are filtered out

### "Claude CLI not found"
- Ensure `claude` is in PATH, or set `CLAUDE_PATH` environment variable
- The CLI must support `--permission-prompt-tool` (recent versions)

### "MCP config schema error"
- The config must be wrapped: `{"mcpServers": {"name": {"type": "stdio", ...}}}`
- Check `src/claude/cli.ts` for the exact format

### "TypeScript build errors"
- Run `bun install` to ensure dependencies are up to date
- Check for type mismatches in event handling

## Debugging with Claude Code History

Claude Code stores all conversation history on disk, which is invaluable for debugging:

```
~/.claude/
├── history.jsonl          # Index of all sessions (metadata only)
├── projects/              # Full conversation transcripts
│   └── -Users-username-project/   # Encoded path (/ → -)
│       ├── session-id-1.jsonl     # Full conversation
│       └── session-id-2.jsonl
├── todos/                 # Todo lists per session
└── settings.json          # User settings
```

**Useful debugging commands:**
```bash
# List recent sessions
tail -20 ~/.claude/history.jsonl | jq -r '.cwd + " " + .name'

# Find sessions for this project
ls ~/.claude/projects/-Users-anneschuth-mattermost-claude-code/

# View a specific session's conversation
cat ~/.claude/projects/-Users-anneschuth-mattermost-claude-code/SESSION_ID.jsonl | jq .
```

**Key points:**
- Directory names are encoded: `/path/to/project/` → `-path-to-project`
- Each session gets a JSONL file with full conversation history
- Consider backing up `~/.claude/` regularly

## Key Implementation Details

### Event Flow (src/operations/transformer.ts → MessageManager)
Claude CLI emits JSON events. The transformer converts them to MessageOperations:
- `assistant` → `AppendContentOp` (text response)
- `tool_use` → `AppendContentOp` (tool display) or special ops (TaskListOp, QuestionOp, etc.)
- `tool_result` → `AppendContentOp` (result indicator) + `FlushOp`
- `result` → `FlushOp` + `StatusUpdateOp` (cost info)

### Message Streaming (src/operations/streaming/handler.ts)
- Messages are batched and flushed periodically via `FlushOp`
- Long content is split across multiple posts (16K limit)
- Diffs and code blocks use syntax highlighting

### Reaction Handling (MessageManager → Executors)
- `MessageManager.handleReaction()` routes to appropriate executor
- Each executor handles its own pending state (questions, approvals, prompts)
- MCP server handles: permission prompts (separate from main bot)
- All filter to only process allowed users' reactions

## Backward Compatibility Requirements

**CRITICAL:** When modifying persisted data structures (`PersistedSession`, `config.yaml`, `sessions.json`), you MUST maintain backward compatibility. Users may upgrade from any older version, and their persisted data must continue to work.

### Rules for Persisted Data Changes

1. **Never remove fields** - Old data may have them, and removing causes silent failures
2. **Never rename fields without migration** - Add migration logic in `session-store.ts` to convert old field names
3. **Always use defensive defaults** - When reading persisted data, use `??` or `||` to provide fallbacks:
   ```typescript
   // GOOD - handles missing fields gracefully
   sessionNumber: state.sessionNumber ?? 1,
   sessionAllowedUsers: new Set(state.sessionAllowedUsers || [state.startedBy].filter(Boolean)),

   // BAD - crashes if field is missing
   sessionNumber: state.sessionNumber,
   sessionAllowedUsers: new Set(state.sessionAllowedUsers),
   ```
4. **Check both old and new field names** when looking up data:
   ```typescript
   // GOOD - supports both old and new field names
   const lifecycleId = session.lifecyclePostId || (session as LegacySession).timeoutPostId;
   ```
5. **Add migrations for field renames** - See `session-store.ts` for examples of migrating `timeoutPostId` → `lifecyclePostId`

### Testing Backward Compatibility

When making changes to persisted data:
1. Create a test session with the OLD code
2. Upgrade to the NEW code
3. Verify the session resumes correctly
4. Verify all features work (tasks, permissions, worktrees, etc.)

### Red-Green Testing for Regression Fixes

> **CRITICAL: Always verify your test is RED without the fix!**
>
> A test that passes regardless of whether the fix exists is USELESS.
> It won't catch future regressions. This is the most common testing mistake.

**The RED-GREEN-REFACTOR cycle:**

| Step | Action | Verification |
|------|--------|--------------|
| 1. **RED** | Write test, temporarily remove fix | Test FAILS |
| 2. **GREEN** | Apply the fix | Test PASSES |
| 3. **REFACTOR** | Clean up code | All tests still pass |

**The #1 Rule:**
```
TEST THE ACTUAL CODE PATH, NOT A COPY OF THE LOGIC!
```

- **WRONG**: Test duplicates the if/then logic inline in the test
  - Test passes even if someone deletes the fix
  - Useless for catching regressions

- **RIGHT**: Test calls the actual function that contains the fix
  - Test fails if fix is removed
  - Actually protects against regressions

**How to verify your test is RED:**
```bash
# 1. Temporarily comment out or revert the fix
git diff src/path/to/file.ts  # Note what you're removing

# 2. Run JUST your test - it MUST fail
bun test --test-name-pattern "your test name"

# 3. If test passes → YOUR TEST IS BROKEN, rewrite it!
#    If test fails → Good! Now restore the fix.

# 4. Run test again with fix - should pass
bun test --test-name-pattern "your test name"

# 5. Run all tests
bun test
```

**Key principles:**
- Test the specific function/method that contains the fix
- If code is hard to test, refactor for testability FIRST
- A regression test MUST fail if someone removes the fix
- "Documents behavior" is NOT the same as "tests the code"

### Files That Store Persisted Data

- `~/.config/claude-threads/sessions.json` - Session state (`PersistedSession` interface)
- `~/.config/claude-threads/config.yaml` - Bot configuration

## Future Improvements to Consider

- [x] Implement Slack platform support - **Done**
- [ ] Add rate limiting for API calls
- [x] Support file uploads via chat attachments - **Done**
- [x] Support multiple concurrent sessions (different threads) - **Done in v0.3.0**
- [x] Add `!stop` command to abort running session - **Done in v0.3.4** (also ❌/🛑 reactions)
- [x] CLI arguments and interactive onboarding - **Done in v0.4.0**
- [x] Session collaboration (`!invite`, `!kick`, message approval) - **Done in v0.5.0**
- [x] Persist session state for recovery after restart - **Done in v0.9.0**
- [x] Add `!escape` command to interrupt without killing session - **Done in v0.10.0** (also ⏸️ reaction)
- [x] Add `!kill` command to emergency shutdown all sessions and exit - **Done in v0.10.0**
- [x] Multi-platform architecture - **Done in v0.14.0**
- [x] Modular session management - **Done in v0.14.0**
- [ ] Add rate limiting for API calls
- [ ] Support file uploads via Mattermost attachments
- [ ] Keep task list at the bottommost message (always update to latest position)
- [ ] Session restart improvements: verify all important state is preserved (cwd ✓, permissions ✓, worktree ✓)
- [x] Accurate context usage: Use per-request `usage` field from result events instead of cumulative billing tokens - **Done**
