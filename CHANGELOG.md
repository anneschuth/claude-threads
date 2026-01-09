# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.49.0] - 2026-01-09

### Added
- **Tabbed session interface** - Sessions now display as tabs with status indicators (●/○/◌), replacing the collapsible list. Press `1-9` to switch between session tabs (#149)
- **Split-screen layout** - New layout with platforms and logs side-by-side in the top section, session tabs and content in the bottom section
- **Stylized platform icons** - New distinctive icons: `𝓜` for Mattermost, `🆂` for Slack
- **Headless mode support** - Bot can now run without a TTY (e.g., in Docker, systemd) with automatic detection and graceful fallback
- **Panel system** - New layout components with priority-based space distribution
- **Modal overlay system** - Update status modal with proper overlay rendering

### Changed
- **Session selection** - Changed from expand/collapse (`expandedSessions: Set`) to tab selection (`selectedSessionId: string`)
- **Typing indicator position** - Moved from floating at bottom to inline in session header title line
- **Panel hints** - Logs panel hints now appear inline with title (e.g., `Logs (19) · up/down scroll...`)

### Fixed
- **Layout spacing** - Fixed duplicate height allocation and adjusted proportions (35% top, 65% bottom)
- **Platform name wrapping** - Increased panel width to prevent "Mattermost" from wrapping

## [0.48.17] - 2026-01-09

### Fixed
- **Typing indicator overflow** - Fixed text wrapping issue showing "eTyping..." on separate line, moved spinner after label (#147)
- **Excessive Slack logging** - Reduced API logging from sticky message cleanup with throttling (max once per 5 min) and time-based filtering (#148)

## [0.48.16] - 2026-01-09

### Added
- **Scrollable logs panel** - Logs are now scrollable with keyboard navigation (↑↓ arrows, g/G for top/bottom). Press `[l]` to focus logs panel for scrolling (#146)
- **Section headings** - Added clear section headings (Platforms, Logs, Threads) with counts
- **Numbered platforms and threads** - Each platform and thread now shows its number for quick reference
- **Clear screen at startup** - Terminal clears at startup for a clean UI

### Changed
- **StatusLine pinned to bottom** - Status bar now stays at the bottom of the terminal
- **Dynamic log height** - Logs section uses available terminal space

## [0.48.15] - 2026-01-09

### Fixed
- **Clean screen on normal shutdown** - Screen now clears on Ctrl+C / quit, not just on update restart (#145)

## [0.48.14] - 2026-01-09

### Fixed
- **Clean screen before update restart** - Screen now clears and cursor is restored before the daemon restarts, so the new UI appears cleanly at the top instead of below the old UI remnants (#144)

## [0.48.13] - 2026-01-09

### Fixed
- **Don't crash when no platforms connect** - Improved 0.48.12 fix to log error instead of throwing when all platforms fail to connect, allowing the bot to stay running so users can fix configuration

## [0.48.12] - 2026-01-09

### Fixed
- **Graceful platform connection failures** - Bot no longer crashes when one platform fails to connect. Failed platforms are automatically disabled and the bot continues with remaining platforms

## [0.48.11] - 2026-01-09

### Reverted
- **Sticky plan approval message** - Reverted #142 due to plan mode issues

## [0.48.10] - 2026-01-09

### Changed
- **Support Claude CLI 2.1.x** - Updated version compatibility range from `>=2.0.74 <=2.1.1` to `>=2.0.74 <2.2.0` to support all 2.1.x releases

## [0.48.9] - 2026-01-08

### Added
- **Sticky plan approval message** - Plan approval messages now stay at the bottom of the thread while pending (similar to task list), with a horizontal rule for visual separation. This improves UX by keeping the approval prompt visible below the plan content (#142)

## [0.48.8] - 2026-01-08

### Fixed
- **Sessions now persist before update restart** - When `!update now` was triggered, sessions were lost because the bot exited without persisting them. Now sessions are properly saved before restart and resume automatically after the update (#141)

## [0.48.7] - 2026-01-08

### Fixed
- **Emoji rendering on Mattermost** - Removed Unicode-to-shortcode conversion that was causing broken emoji display (`:stopwatch:`, `:pause:` etc. showing as text). Modern Mattermost clients (7.x+) render Unicode emoji natively (#140)

## [0.48.6] - 2026-01-08

### Added
- **Claude can execute !worktree list** - Claude can now run `!worktree list` command and receive the results in the conversation, enabling better worktree management (#137)

### Fixed
- **Orphaned pinned sticky messages cleaned up** - Sticky messages from previous bot instances are now properly unpinned and deleted on startup (#138)
- **Stopwatch emoji compatibility** - Changed from Unicode ⏱️ to standard `:stopwatch:` shortcode for better cross-platform compatibility (#139)

## [0.48.5] - 2026-01-08

### Fixed
- **Slack msg_too_long errors fixed** - Messages are now safely truncated before sending to Slack API, preventing 4000+ character errors (#136)
- **Emoji conversion for Slack reactions** - Emoji names like `thumbsup` are now correctly converted to unicode for Slack reactions and Mattermost messages (#135)

## [0.48.4] - 2026-01-08

### Fixed
- **Code blocks no longer split incorrectly** - Messages are now split at line boundaries and never inside code blocks, removing ugly continuation markers (#134)
- **Disabled platforms show dim indicator** - Changed disabled platform status from red (error) to dim (inactive) for clearer visual feedback (#132)

### Added
- **CI smoke test** - Added startup verification to CI pipeline to catch binary launch issues early (#133)

## [0.48.3] - 2026-01-08

### Changed
- **Support Claude CLI 2.1.1** - Updated version compatibility range from `>=2.0.74 <=2.0.76` to `>=2.0.74 <=2.1.1` (#131)

## [0.48.2] - 2026-01-08

### Fixed
- **CI knip checks now pass** - Added `--no-config-hints` flag to knip in CI and pre-commit to handle environment differences (dist/ exists locally but not in CI)

## [0.48.1] - 2026-01-08

### Fixed
- **Pre-commit hooks work with non-JS files** - Added `--allow-empty` to lint-staged so commits with only markdown/config files don't fail
- **Knip no longer flags prettier** - Added prettier to ignoreDependencies and ignoreBinaries in knip config

### Changed
- **Updated release documentation** - Added PR check verification step and removed `--no-verify` flags from release instructions

## [0.48.0] - 2026-01-08

### Added
- **Claude can execute !cd command** - Claude can now output `!cd /path` in responses to change the session's working directory, with visibility messages posted to the thread (#125)

### Fixed
- **Update reactions now work** - Fixed bug where 👍/👎 reactions on auto-update messages were silently ignored due to missing `pendingUpdatePrompt` state (#124)
- **Duplicate task lists prevented** - Replaced promise-lock with atomic lock acquisition pattern to fix race condition causing duplicate task list posts (#126)
- **Worktree paths shortened in Bash** - Bash commands now show `[branch]/path` instead of full worktree paths, matching other tools (#127)

### Removed
- **Removed .env.example** - Configuration is done via YAML config only

## [0.47.0] - 2026-01-07

### Added
- **Session context in system prompt** - Claude now receives metadata about the session including version, current working directory, git status, and platform info (#119)

### Fixed
- **Task list duplication fixed** - Resolved race condition causing duplicate task lists by extending promise lock scope (#122)
- **Code blocks now render correctly** - Added trailing newline to code blocks for proper markdown rendering (#123)
- **Worktree paths shortened in UI** - Paths now show as `[branch]/path` instead of full worktree paths for better readability (#121)
- **Worktree metadata centralized** - Moved `.claude-threads-meta.json` to central config directory to avoid polluting project directories (#120)

### Changed
- **Bump @modelcontextprotocol/sdk** - Updated from 1.25.1 to 1.25.2 (#118)

## [0.46.0] - 2026-01-07

### Added
- **Emoji reactions for `!update` command** - React with 👍 to update immediately or 👎 to defer for 1 hour, easier than typing commands on mobile

### Fixed
- **Auto-update uses bun instead of npm** - Fixed updates to use `bun install -g` matching the actual install location
- **ESLint warnings resolved** - Fixed 8 non-null assertion warnings with proper null checks
- **Dead code removed** - Removed unused Discord formatter/types and other dead code via Knip

### Changed
- **Knip added to CI and pre-commit** - Dead code detection now runs automatically

## [0.45.0] - 2026-01-07

### Added
- **Update modal in CLI UI** - Press `u` to open a modal showing update status, changelog, and options to apply or defer updates
- **Worktree path shortening** - Tool output shows shortened worktree paths as `[branch]/path` instead of full paths for readability

### Fixed
- **Duplicate task list posts in Slack** - Fixed race condition that caused double task list messages
- **Worktree prompt cleanup** - Remove ❌ reaction from worktree prompts after user responds
- **Streaming message failures** - Handle `updatePost` failures gracefully with automatic recovery

### Changed
- **`.claude-threads-meta.json` added to .gitignore** - Session metadata files are no longer tracked

## [0.44.0] - 2026-01-07

### Added
- **Persist platform enabled state** - Platform enabled/disabled toggles (Shift+1-9) now persist across restarts. When you disable a platform, it stays disabled after bot restart.

## [0.43.0] - 2026-01-07

### Added
- **Auto-restart on updates** - Bot automatically restarts after installing updates when running with daemon wrapper
- **`!update` command family** - Check update status, force immediate update (`!update now`), or defer (`!update defer`)
- **`--auto-restart` / `--no-auto-restart` CLI flags** - Control auto-restart behavior (enabled by default when `autoUpdate.enabled`)

### Changed
- **Platform-specific formatting for update messages** - Update notifications now use proper bold/italic formatting per platform (Mattermost vs Slack)
- **Improved daemon wrapper** - Now correctly uses local binary instead of global installation

## [0.42.0] - 2026-01-07

### Fixed
- **Slack message visibility for long sessions** - Add platform-specific message size limits (Slack: 12K, Mattermost: 16K) with error recovery when `updatePost` fails - automatically creates new message instead of silently losing content
- **ExitPlanMode approval on Slack** - Fix emoji reaction handling by normalizing `thumbsup` → `+1` across platforms

### Added
- **`!approve` / `!yes` commands** - Text-based alternative to 👍 reaction for plan approval
- **Plan mode status in session header** - Shows 📋 Plan pending or 🔨 Implementing status

### Changed
- **User follow-up message handling** - Reset `currentPostId` on user follow-up messages so Claude's responses start in fresh messages with proper code block closure

## [0.41.0] - 2026-01-07

### Changed
- **Test coverage threshold increased to 80%** - CI now enforces minimum 80% line coverage (previously 75%)
- **Comprehensive test suite expansion** - Added 400+ new tests bringing total to 942 tests:
  - `src/changelog.test.ts` - Changelog parsing and "What's New" extraction
  - `src/logo.test.ts` - ASCII art logo generation
  - `src/version.test.ts` - Package version resolution
  - `src/session/types.test.ts` - Session type definitions
  - `src/test-utils/mock-formatter.test.ts` - Mock formatter utilities
  - `src/update-notifier.test.ts` - Update notification system
  - Enhanced tests for message-handler, mattermost/api, platform/utils, and session modules

### Added
- **Coverage badge** - README now displays live test coverage percentage via shields.io endpoint

## [0.40.1] - 2026-01-07

### Changed
- **Dependency updates** - Updated ink (5.2.1 → 6.6.0) and react (18.3.1 → 19.2.3)

## [0.40.0] - 2026-01-07

### Added
- **Centralized worktree location** - All worktrees now created in `~/.claude-threads/worktrees/` for easy management
- **`!worktree cleanup` command** - Manually delete current worktree and switch back to repo root
- **Merged branch detection** - Worktrees are automatically cleaned on startup if their branch was merged into main/master
- **Worktree ownership tracking** - Only sessions that created a worktree can trigger cleanup (not sessions that joined)
- **Worktree reference counting** - Prevents deletion while other sessions are using the same worktree

### Changed
- **Worktrees preserved on session exit** - No automatic cleanup when sessions end normally; use `!worktree cleanup` for manual cleanup or wait for orphan cleanup on startup (>24h old)

## [0.39.0] - 2026-01-06

### Added
- **Test coverage enforcement** - CI now enforces minimum 55% code coverage with new unit tests for:
  - `src/claude/cli.test.ts` - Claude CLI spawning and MCP config
  - `src/message-handler.test.ts` - Message routing logic
  - `src/session/manager.test.ts` - Session manager orchestration
  - `src/session/reactions.test.ts` - Emoji reaction handling
- **Slack app manifest** - Added `docs/slack-app-manifest.yaml` for easier Slack app setup
- **Session title/description logging** - Debug logging for extracting session metadata from Claude responses

### Fixed
- **Slack strikethrough formatting** - Escape tildes in strikethrough text to prevent formatting breakage
- **Image files preserved during prompts** - Image files are no longer lost when context/worktree prompts are shown
- **Double newlines between content blocks** - Proper formatting with double newlines for better readability
- **Documentation** - Added `files:read` scope to Slack setup docs

## [0.38.0] - 2026-01-06

### Added
- **Documentation reorganization** - Moved detailed setup guides to `docs/` folder:
  - `docs/CONFIGURATION.md` - Multi-platform configuration reference
  - `docs/MATTERMOST_SETUP.md` - Mattermost setup guide
  - `docs/SLACK_SETUP.md` - Slack setup guide

### Fixed
- **Slack link previews disabled** - Sticky messages and task posts no longer show link unfurls on Slack
- **Jump-to-bottom links include bot posts** - Links now correctly scroll to the latest message including bot's own posts
- **Flaky integration tests** - Fixed timing issues in multi-user and session limit tests

## [0.37.0] - 2026-01-06

### Added
- **Jump to bottom of thread** - Sticky message links now include `?scrollTo=bottom` parameter to jump directly to the latest messages in threads
- **Pause/shutdown status in pinned message** - Channel sticky message now shows when platforms are paused or shutting down with visual indicators (⏸️ paused, 🛑 shutting down)

### Changed
- **Improved spinner animations** - Different spinner styles for different contexts:
  - Braille spinner for typing indicator
  - Dots spinner for session starting
  - Arc spinner for general loading states

### Fixed
- **Code block rendering when messages are split** - Continuation markers (`*... (continued below)*`) now use platform-specific formatting, fixing broken code blocks on Slack
- **Worktree creation failures** - Better error handling when worktree already exists or creation fails:
  - Inline `on branch X` syntax now detects existing worktrees and offers to join them
  - Creation failures now show helpful error messages instead of crashing

## [0.36.0] - 2026-01-06

### Added
- **Platform toggle from UI** - Use `Shift+1-9` to toggle platforms on/off from the terminal UI:
  - When disabled: active sessions are paused, platform disconnects, UI shows gray state
  - When re-enabled: platform reconnects, paused sessions auto-resume
  - Visual feedback in StatusLine with colors (green=connected, gray=disabled, yellow=reconnecting, red=error)
- **Pin active task post** - Task posts are now pinned to the channel for easy access:
  - Pin when task post is created
  - Unpin when all tasks complete or session ends
  - Handles task post "bumping" by unpinning old and pinning new
- **Slack file attachment support** - Fixed bug where Slack messages with image attachments were silently ignored:
  - Now handles `file_share` message subtype correctly
  - Added comprehensive integration tests for Slack file uploads

### Changed
- **Universal markdown formatting** - Added `formatMarkdown()` method to `PlatformFormatter` interface:
  - Claude's responses now render properly on all platforms
  - MattermostFormatter: pass-through (standard markdown)
  - SlackFormatter: converts `**bold**` → `*bold*`, `## headers` → bold, links → Slack format
  - DiscordFormatter: pass-through (standard markdown)

## [0.35.0] - 2026-01-06

### Added
- **Slack platform support** - Full Slack integration using Socket Mode for real-time events:
  - Socket Mode WebSocket connection with automatic reconnection
  - All session features work identically to Mattermost (commands, reactions, permissions, etc.)
  - Slack mrkdwn formatting (single `*bold*`, `~strikethrough~`, unicode horizontal rules)
  - User mention translation (`<@U123>` format)
  - File attachment support with authenticated downloads
  - Rate limiting with exponential backoff
  - Message recovery after disconnection
- **Slack integration tests** - Platform-agnostic test framework that runs the same 116 tests against both Mattermost and Slack mock servers
- **Slack mock server** - Full mock implementation of Slack's Socket Mode and Web API for testing
- **Platform initialization logging** - Better diagnostics showing which platforms are connecting

### Changed
- **Platform-agnostic formatters** - All markdown formatting now goes through `PlatformFormatter` interface for cross-platform compatibility
- **Cross-platform regex patterns** - Task list parsing now handles both `**bold**` (Mattermost) and `*bold*` (Slack) formats

### Fixed
- **Slack WebSocket reliability** - Added 30-second connection timeout and proper promise rejection if WebSocket closes before hello event
- **Expected API errors** - `already_pinned` and `no_pin` Slack errors no longer spam logs

## [0.34.1] - 2026-01-05

### Added
- **Integration test suite** - Comprehensive end-to-end tests that spawn the actual bot against a real Mattermost instance with a mock Claude CLI. 111 tests covering:
  - Session lifecycle (start, response, end, timeout)
  - Commands (!stop, !escape, !help, !cd, !kill, !permissions)
  - Reaction-based controls (❌ cancel, ⏸️ interrupt)
  - Multi-user collaboration (!invite, !kick, message approval)
  - Session persistence and resume after restart
  - Plan approval and question flows
  - Context prompts for mid-thread starts
  - Git worktree integration
  - Error handling and recovery
  - MAX_SESSIONS limits
  - Task list display
- **CI workflow** - GitHub Actions workflow (`integration.yml`) that:
  - Spins up Mattermost in Docker
  - Creates test users, channels, and bot
  - Runs full integration test suite
  - Collects logs on failure for debugging

### Changed
- **Cleaner production code** - Removed test-specific `triggerReactionHandler()` method from SessionManager. Tests now access private methods via TypeScript cast when needed as a WebSocket fallback.

## [0.34.0] - 2026-01-05

### Added
- **Ink/React CLI UI** - Complete rewrite of the terminal interface using Ink (React for CLI). Features include:
  - Collapsible session panels with real-time log streaming
  - Header with logo, version, and working directory
  - Platform status indicators (connected/reconnecting)
  - Per-session and global log panels with color-coded levels
  - Spinner animations for typing/starting states
- **Keyboard toggles** - Runtime settings can be changed without restart:
  - `[d]` Debug mode - toggle verbose logging
  - `[p]` Permissions - toggle interactive/auto mode for new sessions
  - `[c]` Chrome - toggle Chrome integration for new sessions
  - `[k]` Keep-alive - toggle system sleep prevention
  - `[1-9]` Toggle session panel expansion
  - `[q]` Quit
- **Comprehensive logging** - Added debug logging throughout the codebase for better observability:
  - Platform layer (API calls, WebSocket events, user lookups)
  - Session layer (streaming, reactions, commands, lifecycle)
  - CLI layer (process spawn, kill, interrupt)
  - Git worktree operations

### Changed
- **Session status tracking** - New `isProcessing` and `hasClaudeResponded` flags for accurate status display (starting → active → idle)
- **Pre-commit hooks** - Added `typecheck` to lint-staged to match CI checks

### Fixed
- **Duplicate log entries** - Removed redundant logging that caused duplicate entries in UI
- **Pre-UI logging** - Version check no longer logs before UI starts (was cluttering terminal)

## [0.33.8] - 2026-01-04

### Fixed
- **Session resume broken after v0.33.7** - Fixed migration issue where sessions persisted with the old `timeoutPostId` field name couldn't be resumed after upgrading to v0.33.7. The `timeoutPostId` → `lifecyclePostId` rename now includes a proper migration that converts existing sessions on first load.
- **Defensive defaults for persisted session fields** - Session resume now uses safe defaults for all optional fields, preventing crashes when loading sessions from older versions that may have missing fields. Fields like `sessionAllowedUsers`, `planApproved`, `forceInteractivePermissions`, etc. now gracefully default instead of potentially causing undefined errors.
- **Validate required fields before resume** - Sessions with missing critical fields (`threadId`, `platformId`, `claudeSessionId`, `workingDir`) are now skipped gracefully with a warning instead of crashing.

## [0.33.7] - 2026-01-04

### Changed
- **Unified lifecycle post tracking** - Shutdown now uses the same post as timeout/warning, so "Bot shutting down" → "Session resumed" updates a single post instead of creating multiple.
- **Renamed `timeoutPostId` to `lifecyclePostId`** - Better reflects its use across the full session lifecycle (warning → timeout → shutdown → resume).

## [0.33.6] - 2026-01-04

### Changed
- **Duo post repurposing** - Reduced thread noise by updating posts instead of creating new ones for paired events:
  - Compaction: "🗜️ Compacting..." updates to "✅ Context compacted" (single post)
  - Timeout lifecycle: Warning → Timeout → Resume all update the same post
- **DRY refactor** - Added `resetSessionActivity()` helper to clear duo-post IDs on activity, preventing stale post updates in long threads.

## [0.33.5] - 2026-01-04

### Fixed
- **Task toggle emoji disappearing on uncollapse** - Fixed issue where the task toggle emoji (📋) would disappear when uncollapsing the task list. Added re-add of toggle emoji after expanding tasks.
- **Status bar cleanup** - Removed redundant session count from status bars, added keep-alive indicator to show connection health.

## [0.33.4] - 2026-01-04

### Fixed
- **Graceful shutdown now actually waits** - Fixed issue where Ctrl-C would exit immediately instead of waiting for Claude CLI processes to exit gracefully. The `kill()` method now returns a Promise that resolves when the process exits, and shutdown waits for all sessions to complete (up to 2 seconds per session).
- **Signal handlers now work correctly** - Fixed conflict with `when-exit` package (transitive dependency via `update-notifier`) that was intercepting SIGINT before our handlers could run. Now removes conflicting handlers before registering our own.
- **No more reconnection attempts during shutdown** - WebSocket client now tracks intentional disconnects and skips reconnection attempts when shutting down gracefully.

## [0.33.3] - 2026-01-04

### Fixed
- **Graceful shutdown sends two SIGINTs** - Claude CLI requires two Ctrl+C presses to exit in interactive mode. Updated kill() to send two SIGINTs (100ms apart) before falling back to SIGTERM after 2 seconds.

## [0.33.2] - 2026-01-04

### Fixed
- **Session resume "No conversation found" errors** - Fixed issue where cancelled sessions would fail to resume with "No conversation found with session ID" error. Root cause: sessions were persisted before Claude had a chance to save the conversation.
- **Graceful session termination** - When killing a session (cancel, !stop, etc.), Claude now gets 2 seconds to save the conversation (SIGINT then SIGTERM) instead of being killed immediately.
- **Detect invalid session IDs immediately** - Sessions with "No conversation found" errors are now recognized as permanent failures and removed from persistence immediately, instead of retrying 3 times.
- **User notification for early exits** - When a session ends before Claude responds, the user is now notified: "Session ended before Claude could respond. Please start a new session."

### Changed
- **Delayed session persistence** - Sessions are only persisted after Claude has actually responded (first `assistant` or `tool_use` event), preventing dangling session records that can't be resumed.

## [0.33.1] - 2026-01-04

### Fixed
- **Recent threads timestamp** - Fixed "just now" showing incorrectly for recent threads. Now displays when the user last worked on the session (`lastActivityAt`) instead of the internal cleanup timestamp (`cleanedAt`).

### Changed
- **Consolidated time formatting** - Unified duplicate `formatRelativeTime` functions into `utils/format.ts`. Added compact `formatRelativeTimeShort()` for sticky message display (e.g., "5m ago", "2h ago").

## [0.33.0] - 2026-01-03

### Added
- **Compaction status display** - Shows when Claude CLI is compacting context (🗜️ **Compacting context...**) and when it completes (✅ **Context compacted**). Handles `compact_boundary` events with metadata including trigger type and pre-compaction token count.
- **Message recovery after reconnection** - Recovers missed messages after WebSocket disconnections (e.g., machine sleep, network issues). Tracks last processed post ID and fetches missed posts via REST API on reconnect.

### Fixed
- **Timed-out sessions in Recent section** - Fixed bug where timed-out sessions weren't appearing in the "Recent" section of the sticky channel message. Timed-out sessions now show with ⏸️ indicator and a hint to resume via 🔄 reaction.
- **Task toggle emoji behavior** - Changed from flip behavior to state-based: emoji present = expanded, emoji absent = minimized. Added `reaction_removed` event to platform layer.
- **Accurate context token calculation** - Fixed incorrect context token calculation by using `total_input_tokens` from the status line instead of per-request tokens.

## [0.32.0] - 2026-01-03

### Added
- **Claude CLI version check** - Validates Claude CLI version at startup and exits if incompatible (bypass with `--skip-version-check`). Compatible versions: `>=2.0.74 <=2.0.76`. Version is displayed in terminal startup output, sticky channel message, and session headers.

## [0.31.3] - 2026-01-03

### Fixed
- **Clean up stale browser bridge sockets** - Removes stale `claude-mcp-browser-bridge-*` socket files from temp directory before starting Claude CLI. This works around a Claude CLI bug where it tries to `fs.watch()` existing socket files, which fails with `EOPNOTSUPP`. The socket files are left over from previous Chrome integration sessions.

## [0.31.2] - 2026-01-03

### Fixed
- **Detect permanent resume failures immediately** - When resuming a session fails due to Claude CLI's browser bridge temp file issue (EOPNOTSUPP/ENOENT on `claude-mcp-browser-bridge`), the session is now immediately removed from persistence instead of retrying 3 times. This prevents unnecessary retry loops for failures that will never succeed.

## [0.31.1] - 2026-01-03

### Fixed
- **Prevent infinite resume retry loop** - Sessions that crash immediately after resume (e.g., due to Claude CLI Chrome MCP issues) now track failure count and are permanently removed after 3 failed attempts, preventing infinite retry loops on bot restart.

### Changed
- **Updated README** - Comprehensive documentation update covering features from v0.8.0 to v0.31.0, including worktree support, context prompts, session history, and more.

## [0.31.0] - 2026-01-03

### Added
- **Session history retention** - Sessions are now soft-deleted instead of permanently removed when they complete. Session history is kept for display in the sticky message (up to 5 recent sessions). Old history is permanently cleaned up after 3 days.
- **Git branch in session header** - Display the current git branch in the session header table when working in a git repository, providing visibility into which branch the session is operating on.

### Fixed
- **Accurate context usage via status line** - Uses Claude Code's status line feature to get accurate context window usage percentage instead of cumulative billing tokens. Adds a status line writer script that receives accurate per-request token data.

## [0.30.0] - 2026-01-03

### Added
- **Pull request link detection** - When a session is working in a git worktree with an associated PR, the session header and sticky message now display a clickable link to the PR. Automatically detects PRs from GitHub URLs in branch names or upstream tracking.
- **User existence validation for invite/kick** - The `!invite` and `!kick` commands now validate that the user exists on the platform before attempting the action, providing helpful error messages for non-existent users.

### Fixed
- **Accurate context window usage** - Now uses per-request usage data from Claude's result events instead of cumulative billing tokens, providing accurate context window percentage display.
- **Cancelled sessions no longer resume** - Fixed bug where cancelled sessions (killed by user) would incorrectly resume on bot restart by using the correct composite session key for unpersisting.

## [0.29.0] - 2026-01-03

### Changed
- **Unified SessionContext** - Replaced 4 separate context interfaces (LifecycleContext, EventContext, ReactionContext, CommandContext) with a single unified SessionContext for cleaner module dependencies
- **Centralized error handling** - Added `error-handler.ts` with consistent error patterns across all session modules
- **DRY post helpers** - New `post-helpers.ts` with `postInfo`, `postError`, `postWarning` utilities to reduce code duplication
- **Component-based logging** - Migrated from console.log to `createLogger` utility with component prefixes (`[lifecycle]`, `[events]`, `[commands]`, etc.)
- **Platform-agnostic comments** - Updated code comments to be generic rather than Mattermost-specific

### Added
- **Integration tests** - New integration tests for lifecycle and platform modules
- **Format utilities** - New `src/utils/format.ts` with ID formatting and time/number helpers

## [0.28.1] - 2026-01-02

### Fixed
- **Worktree prompts now show in thread list** - Fixed bug where pending worktree prompts (e.g., "Another session is already using this repo...") weren't displayed in the active threads list. The sticky message now updates immediately when these prompts appear.

## [0.28.0] - 2026-01-02

### Added
- **Pending prompts in thread list** - The sticky channel message now shows when sessions are waiting for user input. Pending prompts are displayed with visual indicators:
  - 📋 Plan approval - waiting for plan approval reaction
  - ❓ Question X/Y - multi-step questions with progress
  - 💬 Message approval - unauthorized user message pending
  - 🌿 Branch name - waiting for worktree branch input
  - 🌿 Join worktree - asking to join existing worktree
  - 📝 Context selection - choosing thread context to include
- **Reusable pending prompts API** - New `getPendingPrompts()` and `formatPendingPrompts()` functions exported from session module for displaying pending states anywhere

## [0.27.1] - 2026-01-02

### Fixed
- **Context bar crash when tokens exceed context window** - Fixed crash when usage tokens exceeded the context window limit, causing negative remaining tokens and percentage values over 100%
- **Wait for shutdown message before exiting** - Bot now waits for the "session ended" message to be posted before shutting down, ensuring users see the final status

## [0.27.0] - 2026-01-02

### Added
- **Version in system prompt** - Claude Code now knows which version of Claude Threads it's running under, enabling version-specific behavior and self-reporting

### Fixed
- **Sticky message status bar layout** - Moved status bar above the "Active Claude Threads" header for better visual hierarchy
- **Shorter status bar** - Removed hostname from status bar to reduce clutter

## [0.26.0] - 2026-01-02

### Added
- **Show active task in sticky message** - When Claude is working on tasks, the currently active (in-progress) task is now displayed in the sticky session message. This gives visibility into what Claude is currently working on without scrolling through the thread.

## [0.25.0] - 2026-01-02

### Added
- **Enhanced system prompt with chat platform context** - Claude Code now receives better context about its environment:
  - Understands it's running as a bot via "Claude Threads" in a chat platform
  - Knows how permissions work (emoji reactions 👍/👎)
  - Aware of available user commands (`!stop`, `!escape`, `!invite`, `!kick`, `!cd`, `!permissions`)
  - Understands multiple users can participate in a session
  - This helps Claude provide better UX by understanding its environment and guiding users about available controls

### Fixed
- **Session title/description markers visible in chat** - Fixed issue where `[SESSION_TITLE: ...]` and `[SESSION_DESCRIPTION: ...]` markers would appear in chat messages when validation failed. Markers are now always stripped from displayed text regardless of validation outcome.
- **Session title/description length validation** - Added maximum length limits (title: 50 chars, description: 100 chars) to prevent overly long metadata from cluttering the session header and sticky message.

## [0.24.1] - 2026-01-02

### Fixed
- **Auto-include single-message thread context** - When starting a session in a thread that has only one prior message (the thread starter), it now auto-includes that message as context without prompting. Previously, this would trigger an unnecessary "Include 1 message as context?" prompt with reaction options. Now, single-message context is silently included, while multi-message threads still prompt for confirmation.
- **Worktree branch response excluded from context count** - When a user responds to a worktree branch prompt (e.g., typing "fix/my-branch"), that response is now excluded from the thread context count and messages. Previously, this response was incorrectly counted as conversation context, leading to misleading "Include 2 messages?" prompts when only the original thread starter was meaningful context.
- **Persist sessions before killing on graceful shutdown** - Sessions are now properly persisted before being killed during graceful shutdown (Ctrl+C).

## [0.24.0] - 2026-01-02

### Added
- **Enhanced session status bar with model and context info** - The session header now displays real-time usage information similar to Claude Code's status line:
  - Model name (`🤖 Opus 4.5`, `🤖 Sonnet 4`, etc.)
  - Context usage with visual progress bar (`🟢▓▓░░░░░░░░ 23%`)
  - Session cost (`💰 $0.07`)
  - Color-coded context indicator:
    - 🟢 Green: < 50% (plenty of context)
    - 🟡 Yellow: 50-75% (moderate usage)
    - 🟠 Orange: 75-90% (getting full)
    - 🔴 Red: 90%+ (almost full)
- **Periodic status bar updates** - Status bar now refreshes every 30 seconds automatically to keep uptime and usage stats current
- **Usage stats tracking** - Session now tracks token usage, cost, and model information extracted from Claude CLI result events

### Improved
- **Existing worktree handling** - When a worktree already exists for a branch, the bot now offers to join it with a reaction prompt (👍 to join, ❌ to skip) instead of just showing a warning message that required manually typing `!worktree switch`

### Fixed
- **Task list 🔽 emoji not preserved when bumped** - Fixed issues where the collapse/expand toggle emoji would disappear or get stuck on the wrong post:
  - When a task list is bumped to the bottom, the new post now gets the 🔽 emoji via `createInteractivePost`
  - When a task post is repurposed for other content, the emoji is removed from the old post before reuse
  - Added `removeReaction` method to platform client interface for proper emoji cleanup
- **WorktreeMode type inconsistency** - Aligned the WorktreeMode type definition across the codebase to include 'off' mode

## [0.23.0] - 2026-01-02

### Added
- **Sticky message status bar** - Added a compact status line to the channel sticky message showing system-level info:
  - Bot version (`v0.22.0`)
  - Active sessions count (`3/5 sessions`)
  - Permission mode (`🔐 Interactive` or `⚡ Auto`)
  - Worktree mode (`🌿 Worktree: always/never`) - only shown if not default 'prompt'
  - Chrome status (`🌐 Chrome`) - only when enabled
  - Debug mode (`🐛 Debug`) - only when enabled
  - Battery level (`🔋 85%` or `🔌 AC`) - macOS and Linux
  - Bot uptime (`⏱️ 2h15m`) - how long the bot has been running
  - Working directory (`📂 ~/projects`)
  - Hostname (`💻 hostname`) - machine name for identification

## [0.22.1] - 2026-01-01

### Fixed
- **Missing `diff` dependency** - Added missing `diff` package that was used in tool-formatter but not in package.json
- **Test console output pollution** - Suppressed expected console output in tests (error handling, keep-alive messages)
- **Lint warning in sticky-message** - Removed non-null assertion in favor of proper undefined check

## [0.22.0] - 2026-01-01

### Added
- **Session status bar** - Compact status line between logo and table showing at-a-glance info:
  - Session slots (`1/5`)
  - Permission mode (`🔐 Interactive` or `⚡ Auto`)
  - Chrome status (`🌐 Chrome`) - only when enabled
  - Keep-alive status (`💓 Keep-alive`) - only when active
  - Battery level (`🔋 85%` or `🔌 AC`) - macOS and Linux
  - Session uptime (`⏱️ 5m`, `1h23m`, etc.)

### Changed
- **Slimmer session header table** - Moved session slots, permissions, and Chrome status to the status bar, keeping only contextual info (topic, directory, participants, etc.) in the table

### Fixed
- **Task list collapse toggle not working** - Fixed a bug where clicking the 🔽 emoji to collapse/expand the task list had no effect. The task post ID was not being registered in the reaction routing index, causing all toggle reactions to be silently ignored. Now the task post is properly registered in all scenarios: initial creation, session resume, and after being bumped to the bottom of the thread.

## [0.21.1] - 2026-01-01

### Fixed
- **Subagent layout issue** - Fixed a bug where starting a subagent could create an empty or near-empty message above the task list, causing a broken layout. The fix ensures pending content is flushed before posting subagent status messages.
- **Session title/description not generated after worktree creation** - When a session started with a worktree prompt, the system prompt instructing Claude to generate session metadata was not passed to the restarted Claude CLI in the new worktree directory
- **Code block continuations now preserve formatting** - When a message needs to split mid-way through a code block (diff, typescript, etc.), the code block is now properly closed in the first part and reopened in the continuation
  - Prevents broken markdown when long diffs or code blocks exceed message length limits
  - Adds `getCodeBlockState()` helper to detect when we're inside an unclosed code block
  - `findLogicalBreakpoint()` now avoids breaking inside code blocks when possible
  - When a break inside a code block is unavoidable, properly closes with ``` and reopens with ```language

## [0.21.0] - 2026-01-01

### Added
- **Session title/description in thread header** - The session header table now displays the topic and summary at the top, providing immediate context within the thread itself
- **Periodic metadata reminders** - Every 5 user messages, Claude receives a reminder to update the session title/description if the topic has evolved, ensuring metadata stays current as conversations progress

### Changed
- **Dynamic header updates** - Session header now updates automatically when Claude generates or changes the title/description

### Fixed
- **Session title/description validation** - Reject placeholder values like "..." that Claude sometimes generates instead of real titles/descriptions

## [0.20.0] - 2026-01-01

### Added
- **Sticky message improvements** - Enhanced the channel sticky message with active sessions
  - Shows display name in bold (e.g., **Anne**) instead of username
  - Added session description below the title (generated by Claude)
  - Added install hint: `npm i -g claude-threads` in footer
  - Periodic refresh every 60 seconds to keep relative times current
  - Auto-cleanup of old sticky messages from failed runs at startup

### Fixed
- **Sticky message updates on session end** - Message now updates when sessions are:
  - Canceled via `!stop` or ❌ reaction
  - Paused/interrupted via `!escape` or ⏸️ reaction
  - Killed due to timeout
  - Failed to start or resume
- **Race condition in sticky updates** - Added mutex to prevent duplicate sticky posts when multiple updates happen concurrently

## [0.19.2] - 2026-01-01

### Added
- **Smart message breaking** - Breaks long responses into multiple messages at logical points
  - Reduces "Show More" toggles in Mattermost by breaking messages before they get too long
  - Breaks at logical points: after tool completions, before headings, after code blocks, at paragraph breaks
  - Soft threshold at 2000 chars / 15 lines triggers search for breakpoints
  - Hard threshold at 14K chars ensures messages stay within platform limits
  - Adds `*... (continued below)*` marker when breaking messages

### Fixed
- **Task list stays below subagent messages** - Task list now bumps to bottom when subagents start
  - Previously, subagent status messages would appear below the task list
  - Now the task list correctly repositions itself below subagent posts

## [0.19.1] - 2026-01-01

### Fixed
- **Task list collapse emoji now pre-added** - The 🔽 toggle emoji is now automatically added as a reaction when the task list is created, making it easy to click and collapse/expand the list (previously users had to manually add the emoji)
- **Improved thinking trace display** - Better formatting for extended thinking blocks
  - Use blockquote format (`> 💭 *...*`) for cleaner visual separation
  - Increased preview length from 100 to 200 characters
  - Cut at word boundaries instead of mid-word for cleaner truncation

## [0.19.0] - 2026-01-01

### Added
- **Minimize/expand task list** - Toggle task list visibility with emoji reactions
  - React with 🔽 (`arrow_down_small`) or 🔻 (`small_red_triangle_down`) on the task list to toggle
  - Minimized view shows: `📋 **Tasks** (2/5 · 40%) · 🔄 Current task 🔽`
  - Expanded view shows full task list with all items
  - State persists across session restarts
  - Similar to Ctrl-T in Claude Code CLI

### Changed
- **Unified CLI output styling** - Consistent 2-space indented output with emoji prefixes
  - Created centralized `src/utils/output.ts` module with shared color helpers
  - Keep-alive messages now use `☕ Sleep prevention active (caffeinate)` format instead of `[keep-alive]` prefix
  - All files now import colors from the shared module instead of defining locally

## [0.18.0] - 2026-01-01

### Added
- **Keep-alive support** - Prevents system sleep while Claude sessions are active
  - Automatically starts when first session begins, stops when all sessions end
  - Cross-platform: macOS (`caffeinate`), Linux (`systemd-inhibit`), Windows (`SetThreadExecutionState`)
  - Enabled by default, disable with `--no-keep-alive` CLI flag or `keepAlive: false` in config
  - Shows `☕ Keep-alive enabled` in startup output
- **Resume timed-out sessions via emoji reaction** - React with 🔄 to the timeout message or session header to resume a timed-out session
  - Timeout message now shows resume hint: "💡 React with 🔄 to resume, or send a new message to continue."
  - Resume also works by sending a new message in the thread (existing behavior)
  - Session header now displays truncated session ID for reference
  - Supports multiple resume emojis: 🔄 (arrows_counterclockwise), ▶️ (arrow_forward), 🔁 (repeat)

### Fixed
- **Sticky task list**: Task list now correctly stops being sticky when all tasks are completed
  - Previously, the task list stayed at the bottom even after all tasks had `status: 'completed'`
  - Now properly detects when all tasks are done using `todos.every(t => t.status === 'completed')`

## [0.17.1] - 2025-12-31

### Fixed
- **Sticky task list optimization**: Completed task lists no longer move to the bottom
  - Once all tasks are done, the "~~Tasks~~ *(completed)*" message stays in place
  - Reduces unnecessary message deletions and recreations
  - Added `tasksCompleted` flag to session state for explicit tracking

### Changed
- **Task list visual separator**: Added horizontal rule (`---`) above task list for better visibility

## [0.17.0] - 2025-12-31

### Added
- **Sticky task list** - Task list now stays at the bottom of the thread
  - When Claude posts new content, the task list moves below it
  - When you send a follow-up message, the task list moves below your message
  - Task list updates in place without visual noise
  - Mirrors Claude Code CLI behavior where tasks are always at the bottom

### Fixed
- **Context prompt after restart**: Context prompt now appears after session restarts (worktree creation, `!cd`)
  - Previously, after worktree creation or directory change, the context prompt was skipped
  - Now users can include thread history when Claude restarts in a new directory
  - Added `needsContextPromptOnNextMessage` flag for deferred context prompt (after `!cd`)

## [0.16.8] - 2025-12-31

### Fixed
- **Context prompt**: Fixed context prompt appearing when starting a session with the first message in a thread
  - The triggering message was incorrectly included in the count, making it show "1 message before this point" when there were none

## [0.16.7] - 2025-12-31

### Fixed
- **Session resume**: Validate working directory exists before resuming sessions after restart
  - Prevents crashes when a worktree or directory has been deleted

## [0.16.6] - 2025-12-31

### Added
- **Worktree context**: Replay first user prompt after mid-session worktree creation (`!worktree create`)
- **Thread context prompt**: When starting a session mid-thread (replying to an existing thread), offers to include previous conversation context
  - Shows options for last 3, 5, or 10 messages (only options that make sense for available message count)
  - "All X messages" option when message count doesn't match standard options
  - 30-second timeout defaults to no context
  - Context is prepended to the initial prompt so Claude understands the conversation history

### Fixed
- **Plan mode approval**: Fixed API error "unexpected tool_use_id found in tool_result blocks" when approving plans
  - Claude Code CLI handles ExitPlanMode internally; changed to send user message instead of duplicate tool_result
- **Question reactions**: Fixed 2nd+ questions not responding to emoji reactions
  - Follow-up question posts weren't registered for reaction routing
- **Question answering**: Fixed duplicate tool_result when answering AskUserQuestion
  - Claude Code CLI handles AskUserQuestion internally; changed to send user message
- Session timeout warning showing negative minutes (e.g., "-24min")
- Warning now fires 5 minutes before timeout instead of after 5 minutes idle
- Stale sessions are now cleaned from persistence on startup

## [0.16.3] - 2025-12-31

### Fixed
- Build with `--target node` for Node.js compatibility (fixes "__require is not a function" error)
- Fixed package.json path resolution for bundled builds

## [0.16.2] - 2025-12-31

### Fixed
- CI: Use npm publish for reliable registry authentication (bun publish auth issues)

## [0.16.1] - 2025-12-31

### Fixed
- CI: Skip lifecycle scripts during `bun publish` to avoid husky error

## [0.16.0] - 2025-12-31

### Changed
- **Runtime**: Migrated from Node.js to Bun runtime for 5-8x faster startup
- **WebSocket**: Replaced `ws` package with native Bun WebSocket (browser-style API)
- **YAML**: Replaced `yaml` package with native `Bun.YAML`
- **Testing**: Replaced Vitest with native `bun test`
- **CI/CD**: Updated GitHub Actions to use Bun

### Removed
- Node.js dependency - **Bun 1.2.21+ is now required**
- Dependencies: `ws`, `yaml`, `tsx`, `vitest`, `@vitest/coverage-v8`

### Developer Experience
- ~2x faster test execution with `bun test`
- ~7-10x faster CI package installs
- Native TypeScript execution without transpilation

## [0.15.0] - 2025-12-30

### Changed
- **License**: Changed from MIT to Apache 2.0 (adds patent protection)

### Added
- **Community standards**: CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md
- **GitHub templates**: Issue templates (bug report, feature request), PR template
- **Dependabot**: Automated dependency updates for npm and GitHub Actions
- **README badges**: Added npm downloads, Node.js version, TypeScript, PRs welcome

### Security
- Updated dependencies via Dependabot

## [0.14.1] - 2025-12-30

### Fixed
- Don't show "update available" notice when running a newer version than npm (fixes stale cache edge case)

## [0.14.0] - 2025-12-30

### Added
- **Multi-platform architecture** - Foundation for supporting multiple chat platforms
  - New `PlatformClient` interface abstracts platform differences
  - Normalized types: `PlatformPost`, `PlatformUser`, `PlatformReaction`, `PlatformFile`
  - Mattermost implementation moved to `src/platform/mattermost/`
  - Slack support architecture ready (implementation pending)
- **YAML-based configuration** - New config format
  - Config file: `~/.config/claude-threads/config.yaml`
  - Support for multiple platform instances simultaneously
  - Interactive onboarding wizard creates YAML config

### Changed
- **Modular session management** - Broke 2,500-line monolith into focused modules
  - `session/manager.ts` (~635 lines) - Thin orchestrator
  - `session/lifecycle.ts` (~590 lines) - Session start/resume/exit
  - `session/events.ts` (~480 lines) - Claude CLI event handling
  - `session/commands.ts` (~510 lines) - User commands
  - `session/reactions.ts` (~210 lines) - Emoji reaction handling
  - `session/worktree.ts` (~520 lines) - Git worktree management
  - `session/streaming.ts` (~180 lines) - Message batching
  - Uses dependency injection for testability
- **Platform-agnostic utilities** - Moved emoji helpers to `src/utils/emoji.ts`
- **Cleaner logo exports** - Renamed to generic `getLogo()`, `LOGO`, `LOGO_INLINE`

### Removed
- **Legacy `.env` configuration** - Now uses YAML only (`config.yaml`)
- **`dotenv` dependency** - No longer needed
- Deprecated Mattermost-specific exports (`getMattermostLogo`, `MATTERMOST_LOGO`)
- Internal documentation files (moved to CLAUDE.md)

## [0.13.0] - 2025-12-29

### Added
- **`--setup` flag** - Re-run interactive setup wizard to reconfigure settings
  - Existing .env values are used as defaults (press Enter to keep)
  - Token field allows keeping existing token without re-entering
  - New settings added since initial setup are presented with built-in defaults
  - Config saved back to original location
- **Chrome and worktree settings in onboarding** - New setup prompts for:
  - Chrome integration (yes/no)
  - Git worktree mode (prompt/off/require)

### Changed
- **Improved README** - New tagline and improved intro section
- **Worktree documentation** - Added comprehensive Git Worktrees section to README
- **Updated CLI options** - Added `--chrome`, `--no-chrome`, `--worktree-mode`, `--setup` to README

### Fixed
- **Warning icon alignment** - Fixed spacing of ⚠️ icon in CLI startup output
- **WORKTREE_MODE documentation** - Fixed incorrect values in README (was `always`/`never`, now correctly `off`/`prompt`/`require`)

## [0.12.1] - 2025-12-29

### Fixed
- **Fix logo star positioning** - Right bottom star shifted left as intended
- **Update README** - Title changed to "Claude Threads" and logo added

## [0.12.0] - 2025-12-29

### Changed
- **Renamed project to `claude-threads`** - Complete rebrand from `mm-claude`
  - npm package: `mattermost-claude-code` → `claude-threads`
  - CLI command: `mm-claude` → `claude-threads`
  - Config directory: `~/.config/mm-claude/` → `~/.config/claude-threads/`
  - MCP server: `mm-claude-permissions` → `claude-threads-permissions`
  - GitHub repository: `mattermost-claude-code` → `claude-threads`
- **New CT logo** - Stylized "CT" block characters replace the old "M" logo
  - Fresh visual identity matching the new name

## [0.11.2] - 2025-12-28

### Fixed
- **Fix worktree skip emoji** - Use emoji name `x` instead of Unicode `❌`
  - Mattermost API expects emoji names for reactions, not Unicode characters
  - Was causing "Custom emoji have been disabled" error

## [0.11.1] - 2025-12-28

### Fixed
- **Fix worktree and `!cd` crash** - Claude CLI sessions are tied to working directory
  - Can't use `--resume` when switching directories (session ID is directory-specific)
  - Now generates fresh session ID when changing to worktree or new directory
  - Previously caused "[Exited: 1]" with "No conversation found with session ID"

## [0.11.0] - 2025-12-28

### Added
- **Git worktree support** - Isolate file changes between concurrent sessions
  - Smart detection prompts for a branch when uncommitted changes or concurrent sessions exist
  - Reply with a branch name to create a worktree, or react with ❌ to skip
  - Inline syntax: `@bot on branch feature/x help me implement...`
  - `!worktree <branch>` - Create and switch to a git worktree
  - `!worktree list` - List all worktrees for the repo
  - `!worktree switch <branch>` - Switch to an existing worktree
  - `!worktree remove <branch>` - Remove a worktree
  - `!worktree off` - Disable worktree prompts for this session
  - Configure via `WORKTREE_MODE=off|prompt|require` (default: `prompt`)
  - Worktrees persist after session ends (manual cleanup)
  - Session header shows worktree info when active

## [0.10.11] - 2025-12-28

### Fixed
- **Permission prompts now update after approval/denial** - Shows result inline
  - "⚠️ Permission requested" → "✅ Allowed by @user" or "❌ Denied by @user"
  - Consistent with plan approval and message approval behavior

## [0.10.10] - 2025-12-28

### Fixed
- **Fixed `!permissions interactive` command** - Now actually enables interactive permissions
  - Previously, the command set a flag but didn't restart Claude CLI, so permissions didn't change
  - Now properly restarts Claude CLI with the MCP permission server enabled
  - Permission prompts (👍 Allow | ✅ Allow all | 👎 Deny) now appear as expected
  - Conversation context is preserved via `--resume` flag

## [0.10.9] - 2025-12-28

### Changed
- **Code quality refactoring** - Extracted shared utilities and added comprehensive test suite
  - New `src/mattermost/api.ts` - Shared REST API layer for bot and MCP server
  - New `src/utils/logger.ts` - Standardized logging with `mcpLogger` and `wsLogger`
  - New `createInteractivePost()` helper for posts with reaction options
  - Extracted emoji constants and helpers to `src/mattermost/emoji.ts`
  - Extracted tool formatting to `src/utils/tool-formatter.ts`

### Added
- **125 unit tests** - Comprehensive test coverage for refactored modules
  - API layer tests (21 tests)
  - Emoji helper tests (31 tests)
  - Tool formatter tests (58 tests)
  - Logger tests (15 tests)

## [0.10.8] - 2025-12-28

### Changed
- **Improved Claude in Chrome tool display** - Chrome automation tools now display like the native CLI
  - `🌐 **Chrome**[computer] \`screenshot\`` instead of `🔌 **computer** *(claude-in-chrome)*`
  - Shows action details: `left_click at (608, 51)`, `type "search query"`, `scroll down`
  - Consistent formatting across all Chrome tools (navigate, tabs, read_page, etc.)

## [0.10.7] - 2025-12-28

### Fixed
- **Fixed `!context` and `!cost` commands** - These commands now properly display output
  - Claude Code slash commands (`/context`, `/cost`) output via `user` events with `<local-command-stdout>` tags
  - Added handling for these events so the output is displayed in Mattermost

## [0.10.6] - 2025-12-28

### Fixed
- **Fixed diff display** - Removed misleading line numbers and noise from diffs
  - No more fake `@@ -1,1 +1,1 @@` headers (we don't have real line numbers)
  - No more `\ No newline at end of file` noise
  - Uses `diffLines()` for proper line-by-line change detection
  - Shows context lines (unchanged parts) naturally

## [0.10.5] - 2025-12-28

### Changed
- **Improved diff display** - Edit operations now show unified diffs with context
  - Uses standard unified diff format (like `git diff`)
  - Shows 3 lines of context around changes
  - More compact: changed lines shown once, not duplicated
  - Line numbers in `@@ -X,Y +X,Y @@` format

## [0.10.4] - 2025-12-28

### Added
- **`--chrome` flag** - Enable Claude in Chrome integration
  - Pass `--chrome` CLI flag or set `CLAUDE_CHROME=true` environment variable
  - Allows Claude to control your Chrome browser for web automation
  - Use `--no-chrome` to explicitly disable
- **Claude Code commands** - New session commands for context and cost management
  - `!context` - Show context usage (tokens used/remaining)
  - `!cost` - Show token usage and cost for this session
  - `!compact` - Compress context to free up space (useful when running low on context)
  - Commands are translated to Claude Code's `/context`, `/cost`, `/compact` slash commands

## [0.10.3] - 2025-12-28

### Changed
- **Improved task list UX**
  - Progress indicator: `📋 **Tasks** (2/5 · 40%)`
  - Elapsed time for in-progress tasks: `🔄 **Running tests...** (45s)`
  - Better pending icon: `○` instead of `⬜` (no longer overlaps)
- **Tool output now shows elapsed time**
  - Long-running tools (≥3s) show completion time: `↳ ✓ (12s)`
  - Errors also show timing: `↳ ❌ Error (5s)`

### Fixed
- **Paused sessions now resume on new message** - messages to paused sessions were being ignored
  - After ⏸️ interrupt, sending a new message in the thread now resumes the session
  - Previously messages without @mention were ignored because the session was removed from memory
  - Added `hasPausedSession()`, `resumePausedSession()`, and `getPersistedSession()` methods

## [0.10.2] - 2025-12-28

### Changed
- Version number now displays directly after "claude-threads" in the logo instead of on a separate line

### Fixed
- **Interrupt (⏸️) no longer kills session** - sessions now pause and can be resumed
  - Previously SIGINT caused Claude CLI to exit and the session was lost
  - Now session is preserved and user can send a new message to continue
  - Works with both ⏸️ reaction and `!escape`/`!interrupt` commands
- **Filter `<thinking>` tags from output** - Claude's internal thinking is no longer shown to users
  - Previously `<thinking>...</thinking>` tags would appear literally in Mattermost messages

## [0.10.1] - 2025-12-28

### Fixed
- **`!kill` now works from any message** - previously only worked within active session threads
  - Can now send `!kill` or `@bot !kill` as the very first message to emergency shutdown
  - Useful when bot is misbehaving and you need to stop it immediately

## [0.10.0] - 2025-12-28

### Added
- **ASCII art logo** - Stylized "M" in Claude Code's block character style
  - Shows on CLI startup with Mattermost blue and Claude orange colors
  - Shows at the top of every Mattermost session thread
  - Festive stars (✴) surround the logo
- **`!kill` command** - Emergency shutdown that kills ALL sessions and exits the bot
  - Only available to globally authorized users (ALLOWED_USERS)
  - Unpersists all sessions (they won't resume on restart)
  - Posts notification to all active session threads before exiting
- **`!escape` / `!interrupt` commands** - Soft interrupt like pressing Escape in CLI
  - Sends SIGINT to Claude CLI, stopping current task
  - Session stays alive and user can continue the conversation
  - Also available via ⏸️ reaction on any message in the session

### Fixed
- **Fix plan mode getting stuck after approval** - tool calls now get proper responses
  - `ExitPlanMode` and `AskUserQuestion` now receive `tool_result` instead of user messages
  - Claude was waiting for tool results that never came, causing sessions to hang
  - Added `toolUseId` tracking to `PendingApproval` interface

## [0.9.3] - 2025-12-28

### Fixed
- **Major fix for session persistence** - completely rewrote session lifecycle management
  - Sessions now correctly survive bot restarts (was broken in 0.9.0-0.9.2)
  - `killAllSessions()` now explicitly preserves persistence instead of relying on exit event timing
  - `killSession()` now takes an `unpersist` parameter to control persistence behavior
  - `handleExit()` now only unpersists on graceful exits (code 0), not on errors
  - Resumed sessions that fail are preserved for retry instead of being removed
  - Added comprehensive debug logging to trace session lifecycle
  - Race condition between shutdown and exit events eliminated

## [0.9.2] - 2025-12-28

### Fixed
- **Fix session persistence** - sessions were being incorrectly cleaned as "stale" on startup
  - The `cleanStale()` call was removing sessions older than 30 minutes before attempting to resume
  - Now sessions survive bot restarts regardless of how long the bot was down
  - Added debug logging (`DEBUG=1`) to trace persistence operations
- **Fix crash on Mattermost API errors** - bot no longer crashes when posts fail
  - Added try-catch around message handler to prevent unhandled exceptions
  - Added try-catch around reaction handler
  - Graceful error handling when session start post fails (e.g., deleted thread)

## [0.9.1] - 2025-12-28

### Changed
- Resume message now shows version: "Session resumed after bot restart (v0.9.1)"
- Session header is updated with new version after resume

### Fixed
- Fix duplicate "Bot shutting down" messages when stopping bot
- Fix "[Exited: null]" message appearing during graceful shutdown

## [0.9.0] - 2025-12-28

### Added
- **Session persistence** - Sessions now survive bot restarts!
  - Active sessions are saved to `~/.config/claude-threads/sessions.json`
  - On bot restart, sessions are automatically resumed using Claude's `--resume` flag
  - Users see "Bot shutting down - session will resume" when bot stops
  - Users see "Session resumed after bot restart" when session resumes
  - Session state (participants, working dir, permissions) is preserved
  - Stale sessions (older than SESSION_TIMEOUT_MS) are cleaned up on startup
  - Thread existence is verified before resuming (deleted threads are skipped)

### Fixed
- Truncate messages longer than 16K chars to avoid Mattermost API errors

## [0.8.1] - 2025-12-28

### Added
- **`!release-notes` command** - Show release notes for the current version
- **"What's new" in session header** - Shows a brief summary of new features when starting a session

## [0.8.0] - 2025-12-28

### Added
- **Image attachment support** - Attach images to your messages and Claude Code will analyze them
- Supports JPEG, PNG, GIF, and WebP formats
- Images are downloaded from Mattermost and sent to Claude as base64-encoded content blocks
- Works for both new sessions and follow-up messages
- Debug logging shows attached image details (name, type, size)

## [0.7.3] - 2025-12-28

### Fixed
- Actually fix `!cd` showing "[Exited: null]" - reset flag in async exit handler, not synchronously

## [0.7.2] - 2025-12-28

### Fixed
- Fix `!cd` command showing "[Exited: null]" message - now properly suppresses exit message during intentional restart

## [0.7.1] - 2025-12-28

### Fixed
- Fix infinite loop when plan is approved - no longer sends "Continue" message on subsequent ExitPlanMode calls

## [0.7.0] - 2025-12-28

### Added
- **`!cd <path>` command** - Change working directory mid-session
- Restarts Claude Code in the new directory with fresh context
- Session header updates to show current working directory
- Validates directory exists before switching

## [0.6.1] - 2025-12-28

### Changed
- Cleaner console output: removed verbose `[Session]` prefixes from logs
- Debug-only logging for internal session state changes (plan approval, question handling)
- Consistent emoji formatting for all log messages

## [0.6.0] - 2025-12-28

### Added
- **Auto-update notifications** - shows banner in session header when new version is available
- Checks npm registry on startup for latest version
- Update notice includes install command: `npm install -g claude-threads`

## [0.5.9] - 2025-12-28

### Fixed
- Security fix: sanitize bot username in regex to prevent injection

## [0.5.8] - 2025-12-28

### Changed
- Commands now use `!` prefix instead of `/` to avoid Mattermost slash command conflicts
- `!help`, `!invite`, `!kick`, `!permissions`, `!stop` replace `/` versions
- Commands without prefix (`help`, `stop`, `cancel`) still work

## [0.5.7] - 2025-12-28

### Fixed
- Bot now recognizes mentions with hyphens in username (e.g., `@annes-minion`)
- Side conversation detection regex updated to handle full Mattermost usernames

## [0.5.6] - 2025-12-28

### Added
- Timeout warning 5 minutes before session expires
- Warning message tells user to send a message to keep session alive
- Warning resets if activity resumes

## [0.5.5] - 2025-12-28

### Added
- `/help` command to show available session commands

### Changed
- Replace ASCII diagram with Mermaid flowchart in README

## [0.5.4] - 2025-12-28 (not released)

### Added
- `/help` command to show available session commands

## [0.5.3] - 2025-12-28

### Added
- `/permissions interactive` command to enable interactive permissions for a session
- Can only downgrade permissions (auto → interactive), not upgrade
- Session header updates to show current permission mode

## [0.5.2] - 2025-12-28

### Changed
- Complete README rewrite with full documentation of all features

## [0.5.1] - 2025-12-28

### Added
- `--no-skip-permissions` flag to enable interactive permissions even when `SKIP_PERMISSIONS=true` is set in env

## [0.5.0] - 2025-12-28

### Added
- **Session collaboration** - invite users to specific sessions without global access
- **`/invite @username`** - Temporarily allow a user to participate in the current session
- **`/kick @username`** - Remove an invited user from the current session
- **Message approval flow** - When unauthorized users send messages in a session thread, the session owner/allowed users can approve via reactions:
  - 👍 Allow this single message
  - ✅ Invite them to the session
  - 👎 Deny the message
- Per-session allowlist tracked via `sessionAllowedUsers` in each session
- **Side conversation support** - Messages starting with `@someone-else` are ignored, allowing users to chat without triggering the bot
- **Dynamic session header** - The session start message updates to show current participants when users are invited or kicked

### Changed
- Session owner is automatically added to session allowlist
- Authorization checks now use `isUserAllowedInSession()` for follow-ups
- Globally allowed users can still access all sessions

## [0.4.0] - 2025-12-28

### Added
- **CLI arguments** to override all config options (`--url`, `--token`, `--channel`, etc.)
- **Interactive onboarding** when no `.env` file exists - guided setup with help text
- Full `--help` output with all available options
- `--debug` flag to enable verbose logging

### Changed
- Switched from manual arg parsing to `commander` for better CLI experience
- Config now supports: CLI args > environment variables > defaults

## [0.3.4] - 2025-12-27

### Added
- Cancel sessions with `/stop`, `/cancel`, `stop`, or `cancel` commands in thread
- Cancel sessions by reacting with ❌ or 🛑 to any post in the thread

## [0.3.3] - 2025-12-27

### Added
- WebSocket heartbeat to detect dead connections after laptop sleep/idle
- Automatic reconnection when connection goes silent for 60+ seconds
- Ping every 30 seconds to keep connection alive

### Fixed
- Connections no longer go "zombie" after laptop sleep - claude-threads now detects and reconnects

## [0.3.2] - 2025-12-27

### Fixed
- Session card now correctly shows "claude-threads" instead of "Claude Code"

## [0.3.1] - 2025-12-27

### Changed
- Cleaner console output with colors (verbose logs only shown with `DEBUG=1`)
- Pimped session start card in Mattermost with version, directory, user, session count, permissions mode, and prompt preview
- Typing indicator starts immediately when session begins
- Shortened thread IDs in logs for readability

## [0.3.0] - 2025-12-27

### Added
- **Multiple concurrent sessions** - each Mattermost thread gets its own Claude CLI process
- Sessions tracked via `sessions: Map<threadId, Session>` and `postIndex: Map<postId, threadId>`
- Configurable session limits via `MAX_SESSIONS` env var (default: 5)
- Automatic idle session cleanup via `SESSION_TIMEOUT_MS` env var (default: 30 min)
- `killAllSessions()` for graceful shutdown of all sessions
- Session count logging for monitoring

### Changed
- `SessionManager` now manages multiple sessions instead of single session
- `sendFollowUp(threadId, message)` takes threadId parameter
- `isInSessionThread(threadId)` replaces `isInCurrentSessionThread()`
- `killSession(threadId)` takes threadId parameter

### Fixed
- Reaction routing now uses post index lookup for correct session targeting

## [0.2.3] - 2025-12-27

### Added
- GitHub Actions workflow for automated npm publishing on release

## [0.2.2] - 2025-12-27

### Added
- Comprehensive `CLAUDE.md` with project documentation for AI assistants

## [0.2.1] - 2025-12-27

### Added
- `--version` / `-v` flag to display version
- Version number shown in `--help` output

### Changed
- Lazy config loading (no .env file needed for --version/--help)

## [0.2.0] - 2025-12-27

### Added
- Interactive permission approval via Mattermost reactions
- Permission prompts forwarded to Mattermost thread
- React with 👍 to allow, ✅ to allow all, or 👎 to deny
- Only authorized users (ALLOWED_USERS) can approve permissions
- MCP-based permission server using Claude Code's `--permission-prompt-tool`
- `SKIP_PERMISSIONS` env var to control permission behavior

### Changed
- Permissions are now interactive by default (previously skipped)
- Use `SKIP_PERMISSIONS=true` or `--dangerously-skip-permissions` to skip

## [0.1.0] - 2024-12-27

### Added
- Initial release
- Connect Claude Code CLI to Mattermost channels
- Real-time streaming of Claude responses
- Interactive plan approval with emoji reactions
- Sequential question flow with emoji answers
- Task list display with live updates
- Code diffs for Edit operations
- Content preview for Write operations
- Subagent status tracking
- Typing indicator while Claude is processing
- User allowlist for access control
- Bot mention detection for triggering sessions
