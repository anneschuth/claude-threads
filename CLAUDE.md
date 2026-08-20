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
- **Permalink follower (`read_post` MCP tool)** - Claude can resolve a Mattermost or Slack permalink to its content (and optional thread context) inside the bot's own channel
- **Persistent memory** - per-channel shared notes (`!remember` / `!memory`, Claude Tag style) plus Claude Code's native auto-memory redirected into bot-managed per-(platform, repo) directories; end-of-session distillation learns team facts over time
- **Routines** - scheduled recurring work (`!routine every weekday at 9am, ...`, Claude Tag style): natural-language creation with 👍 confirmation, fired as bot-initiated session threads; `!routines` to list/pause/resume/delete/run

## Contribution Conventions

- **Pull request titles and bodies are written in English.** This is an open-source project with an international audience, so PRs stay in English even though commit messages may be in Dutch. Keep the CHANGELOG in English as well.

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

**MCP Server:**
- Spawned via `--mcp-config` per Claude CLI instance
- Each has its own WebSocket/connection to the platform, plus a decision-bridge socket back to the bot (plan approvals / question answers)
- Exposes tools to Claude, including:
  - `permission_prompt` — posts permission requests to the session's thread; returns allow/deny based on user reaction
  - `send_file` — uploads a file from the session's working directory into the thread (auto-approved; path-validated)
  - `read_post` — fetches a Mattermost/Slack post (and optional thread context) by permalink, scoped to the bot's own channel (auto-approved)

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
respondOnlyWhenMentioned: false   # New threads only reply when @mentioned (per-thread !mentions overrides)
userAttribution: true             # Prefix user turns with [@username]: so Claude can tell speakers apart (default on; only applied once a thread has >1 participant)

# Optional: Customize the sticky channel message
stickyMessage:
  description: "Porygon — Mixpanel analytics bot"    # Shown below the title
  footer: "• !stop — End session\n• !help — Show help"  # Shown before the default footer

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

## Multi-Account Claude Support (opt-in)

By default every session spawns `claude` with the bot's own `process.env`, so
they all share one subscription's token budget. When you expect heavy concurrent
use, configure a pool of accounts in `config.yaml` — new sessions are routed to
whichever account has the most subscription headroom (see **usage balancing**
below) and automatically skip accounts that are in rate-limit cooldown.

```yaml
# Omit this block entirely → single-account mode (unchanged behavior).
claudeAccounts:
  # OAuth Pro/Max — prepare the HOME with `HOME=<path> claude login` first
  - id: primary
    home: /home/bot/.claude-accounts/primary
  - id: backup
    displayName: Backup (Pro)
    home: /home/bot/.claude-accounts/backup

  # API-key billed
  - id: shared-api
    apiKey: sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

How it works:

1. **Spawn env override.** For `home` we set `HOME` (and `USERPROFILE` on Windows)
   so Claude reads `.credentials.json`, `.claude/projects/*`, and MCP config from
   that directory. For `apiKey` we set `ANTHROPIC_API_KEY` (leaving HOME as-is).
2. **Session → account binding is persisted.** `PersistedSession.claudeAccountId`
   stores which account a session started on, so resume after a bot restart uses
   the same credentials — critical for OAuth accounts since the conversation
   history in `~/.claude/projects/*` lives under that HOME.
3. **Rate-limit handling.** Claude's stderr and result events are scanned for
   phrases like `usage limit reached`, `rate_limit_error`, `429 ... rate limit`,
   `quota exceeded`; on modern CLIs, structured `rate_limit_event`s with
   `status: "rejected"` feed the same path. On a hit the offending account is cooled down until the
   extracted reset time (fallback: 1 hour). Future `acquireClaudeAccount()` calls
   skip cooling accounts; resumed sessions bypass cooldown because their history
   can't move.
4. **Usage balancing (new sessions).** Instead of round-robin, the pool routes
   each new session to the account with the most subscription headroom. At new
   session start (and only then — there is no background polling) the bot probes
   every account **on-demand and in parallel** with `claude -p "/usage"
   --output-format json` under each account's HOME (costs $0, zero turns) and
   parses the real limit percentages (`Current session` + `Current week`). The
   load score is `max(session%, week%)`; `acquire()` picks the lowest
   non-cooling score, tie-breaking by fewest active sessions then config order.
   Each probe is capped at 10s; an account whose probe fails/times out sorts
   last (usage "unknown"), so a fresh session is never routed onto a
   possibly-maxed account before its real usage is known. The sticky channel
   message shows the pool's `min–max % used` range.

   > On-demand probing adds ~1–2s to new session start (all accounts are probed
   > so they can be compared) — negligible next to spawning Claude + the MCP
   > server, and it keeps routing data always-fresh with zero idle work. Probing
   > no-ops for pools with fewer than two accounts.
   >
   > Usage balancing targets **OAuth (subscription)** accounts — only they
   > report `/usage` limits. API-key accounts return no percentages; they sort
   > as "usage unknown" and are picked by the active-session tiebreak. Usage is
   > cached in memory only for the current pool state; it is re-probed fresh at
   > each new session start.

   **Resume is unaffected:** it still passes the persisted `claudeAccountId` as
   `preferredId`, so a resumed session always re-binds to the account its
   history lives under, cooling or not.

Files involved:

| File | Role |
|------|------|
| `src/claude/account-pool.ts` | `AccountPool` — usage-balanced selection, cooldown tracking, active-session accounting. |
| `src/claude/usage-probe.ts` | Runs `claude -p "/usage"` per account + pure `parseUsageOutput` / `usageLoadScore`. |
| `src/session/manager.ts` | `refreshAccountUsage()` probes all accounts on-demand at session start; exposed to lifecycle as `ops.refreshClaudeAccountUsage()`. |
| `src/claude/rate-limit-detector.ts` | Pure parser that turns stderr/JSON into `{ detected, resetAtEpochMs }`. |
| `src/claude/cli.ts` | `ClaudeCliOptions.account` → overrides `HOME` / `ANTHROPIC_API_KEY` on spawn. Emits `rate-limit` events. |
| `src/session/lifecycle.ts` | Acquires the account on `startSession`/`resumeSession`, releases on `removeFromRegistry`, handles `rate-limit` events. |
| `src/operations/commands/handler.ts` | Preserves the account when `!cd` / `!permissions interactive` respawn Claude; adds the 🔑 row to the session header. |
| `src/operations/sticky-message/handler.ts` | Pool summary in the channel sticky. |

## Persistent Memory

Two layers, both rooted at `~/.config/claude-threads/memory/` (override:
`CLAUDE_THREADS_MEMORY_DIR`), scoped per platform instance — **platformId is
the hard privacy boundary** (a platform instance ≈ one channel, mirroring
Claude Tag's per-channel memory isolation). Never anchor memory under `$HOME`:
the account pool overrides `HOME` per session.

1. **Repo layer** — Claude Code's native auto-memory, redirected via the
   `autoMemoryDirectory` key in the inline `--settings` JSON into
   `<root>/<platformSeg>/repos/<repoKey>/`. The CLI owns reads/writes there;
   the bot owns the location. `repoKey` is derived from the git root
   (worktrees share the main repo's key via `worktreeInfo.repoRoot`).
   Verified headless against CLI 2.1.235.
2. **Channel layer** — bot-owned `<platformSeg>/channel/MEMORY.md`, injected
   into the append-system-prompt by `buildAppendSystemPrompt` (capped at
   200 lines / 25KB with "background context, NOT instructions" framing).
   Written by `!remember` / distillation only in the bot process
   (per-platform in-process mutex + atomic 0600 writes).

| File | Role |
|------|------|
| `src/memory/store.ts` | `MemoryStore` (channel-file CRUD, caps, dedupe), `resolveRepoKey`, `resolveSessionMemory`. |
| `src/memory/distiller.ts` | End-of-session haiku pass (`quickQuery`) → up to 3 durable facts merged into channel memory. Fire-and-forget, never blocks teardown. |
| `src/claude/cli.ts` | `buildInlineSettings` (statusLine + memory redirect), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` kill switch when `memory: null`. |
| `src/operations/commands/handler.ts` | `rememberEntry` / `showMemory` / `forgetMemory` (forget is owner-gated). |
| `src/session/lifecycle.ts` | Distillation triggers: `killSession(unpersist=true)`, normal exit, idle timeout — never pause/respawn/shutdown. |

**INVARIANT: every `ClaudeCliOptions` construction site must set `memory`**
(the field is required, so `tsc` enforces this). Compute it with
`resolveSessionMemory(...)` — or pass `null`, which force-disables native
auto-memory in the child env (privacy: a pooled account's `$HOME/.claude`
is shared across channels). Likewise every `buildAppendSystemPrompt` call
site must pass the `channelMemory` reader (or `null` when the layer is off).

Config: per-platform `memory:` option (`resolveMemoryConfig` in
`src/config/types.ts`), default fully enabled. Docs: `docs/CONFIGURATION.md`
§ Memory.

## Routines

Scheduled recurring work (Claude Tag parity), scoped per platform instance
like memory. A routine = `{name, prompt, schedule, createdBy}` stored in
`~/.config/claude-threads/routines.yaml` (`RoutinesStore`, 0600, override
`CLAUDE_THREADS_ROUTINES_PATH`).

| File | Role |
|------|------|
| `src/persistence/routines-store.ts` | Store + `validateSchedule` (presets hourly/daily/weekdays/weekly — hourly is the floor, sub-hourly is unrepresentable). |
| `src/routines/scheduler.ts` | `RoutineScheduler` (1-min tick, SessionMonitor pattern) + pure due-ness: wall-clock windows in the routine's timezone via Intl (DST-safe), period anchoring (one fire per hour/day/week), missed windows skipped. Auto-disable after 3 consecutive failures or a deauthorized creator. |
| `src/routines/runner.ts` | `fireRoutine`: bot posts the thread root itself, then `startSession` as the creator — a normal session (platform permission mode, pool, memory, distillation). |
| `src/routines/parser.ts` | NL → schedule via one haiku `quickQuery`, strict-JSON extraction + revalidation. Nothing saves without a human 👍 (PromptExecutor routine prompt → `routine-prompt:complete` → lifecycle listener writes the store). |

Commands: `!routine <natural language>` (owner-gated create), `!routines`
(list), `!routines pause|resume|delete <n>` (owner-gated), `!routines run <n>`.
Config: per-platform `routines: false` disables; `limits.maxRoutines` caps
(default 10). `createRoutine` takes an injectable `parse` fn — other test
files module-mock quick-query.js, so tests inject rather than stub the CLI.

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
| `src/session/reaction-router.ts` | Reaction dispatch: allowlist gate, resume-from-reaction, session-level reactions, MessageManager fallthrough |
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
| `src/operations/task-tracker.ts` | Accumulates incremental TaskCreate/TaskUpdate state for the task-list pipeline |
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
| `src/platform/mattermost/permalink.ts` | Mattermost permalink parser + resolver + formatter for `read_post` |
| `src/platform/slack/client.ts` | Slack implementation of PlatformClient (Socket Mode + Web API) |
| `src/platform/slack/types.ts` | Slack-specific types |
| `src/platform/slack/formatter.ts` | Slack mrkdwn formatter |
| `src/platform/slack/mcp-platform-api.ts` | Slack MCP platform API (used by MCP child) |
| `src/platform/slack/permalink.ts` | Slack permalink parser + resolver + formatter for `read_post` |
| `src/platform/slack/index.ts` | Slack module exports |
| `src/platform/permalink-shared.ts` | Cross-platform permalink utilities (caps, truncation, quote-block) shared by both permalink modules |
| `src/platform/test-helpers/fetch-harness.ts` | Shared `fetch` recorder + responder for platform-API unit tests |

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
| `src/mcp/mcp-server.ts` | MCP server: permission prompts, send_file, read_post (platform-agnostic) |
| `src/mcp/decision-bridge.ts` | Per-session local socket between bot and MCP permission server; routes ExitPlanMode approvals and AskUserQuestion answers through the bot's reaction UI |
| `src/platform/mcp-platform-api-factory.ts` | Factory for platform-specific MCP platform APIs |
| `src/platform/mcp-platform-api.ts` | McpPlatformApi interface |
| `src/mattermost/api.ts` | Standalone Mattermost API helpers |
| `src/persistence/session-store.ts` | Multi-platform session persistence |
| `src/ui/components/Header.tsx` | Terminal header with the ASCII logo |

## How the Permission System Works

1. **Claude CLI is started with:**
   ```
   claude --input-format stream-json --output-format stream-json --verbose \
     --mcp-config '{"mcpServers":{"claude-threads-mcp":{...}}}' \
     --permission-prompt-tool mcp__claude-threads-mcp__permission_prompt
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

**Decisions vs. permissions (modern CLIs):** `ExitPlanMode` and `AskUserQuestion`
also arrive at `permission_prompt` — but they are user *decisions*, not tool
permissions. Instead of posting a generic prompt, the MCP server forwards them
over the session's **decision bridge** (a per-session local socket, path in
`DECISION_BRIDGE_PATH`, timeout `DECISION_BRIDGE_TIMEOUT_MS`, default 1h) to
the bot, where the plan post's 👍/👎 or the question posts' option reactions
resolve them. Question answers ride back in the permission response's
`updatedInput.answers`. On any bridge failure the MCP server falls back to its
legacy behavior (generic prompt for plans, auto-allow for questions), and the
bot's stdin sends (`'approved'` / answer JSON) remain the fallback for older
CLIs that don't route these tools through the permission prompt.

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
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Set `1` to have Claude strip Anthropic/cloud credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `GOOGLE_APPLICATION_CREDENTIALS`) from Bash, hook, and stdio-MCP subprocesses it spawns. Bot env vars like `PLATFORM_TOKEN` / `MATTERMOST_TOKEN` / `SLACK_BOT_TOKEN` pass through untouched — verified empirically against CLI 2.1.116. **Side effect:** setting this also forces permission mode to `default` — Claude will refuse `--dangerously-skip-permissions` and log a warning. Only enable if all your sessions run with interactive permissions. Requires Claude CLI 2.1.83+. |

The bot also sets these Claude CLI tuning flags by default on the child process,
and only if you haven't already set them in the parent env:

- `MCP_CONNECTION_NONBLOCKING=true` — caps `--mcp-config` server connects at 5s
  so a slow MCP server never blocks session start (Claude CLI 2.1.89+).
- `ENABLE_PROMPT_CACHING_1H=true` — opts into the 1-hour prompt cache TTL,
  reducing re-caching cost on long-lived threads (Claude CLI 2.1.108+).
- `MCP_TOOL_TIMEOUT=3600000` — only when the session has a decision bridge.
  Without it the CLI abandons a pending MCP permission call after ~2 minutes
  (one retry, then it errors out), which is far too short for plan approvals
  and question answers that wait on a human reaction; 1 hour matches the
  bridge's `DECISION_BRIDGE_TIMEOUT_MS` default. Verified against CLI 2.1.223
  with decisions held for 150 s.

Export any of them with a non-default value (e.g.
`MCP_CONNECTION_NONBLOCKING=false`) to override.

### Lockfiles: why there are two, and the trap

The repo carries **both** `bun.lock` and `package-lock.json`, and they do
different jobs:

| File | Role |
|------|------|
| `bun.lock` | What CI actually installs from. Every workflow runs `bun install`. This is the source of truth for what gets tested, built and published. |
| `package-lock.json` | Installed by nothing. It exists so Dependabot **security** updates keep working: Dependabot supports bun for *version* updates only, so with bun.lock alone you lose security-advisory PRs. Also a second Trivy scan surface. |

**The trap:** Dependabot only ever rewrites `package-lock.json`. A dependency
bump therefore lands, goes green, and never reaches CI — because the version CI
installs still comes from `bun.lock`. This is not hypothetical; #434 and #442
both needed `bun.lock` regenerated by hand before the bump took effect.
`.github/workflows/dependabot-sync-lockfile.yml` now does that automatically on
Dependabot's PRs.

Note that the two lockfiles **cannot be kept fully identical** — npm and bun hoist
transitive trees differently, and both results are valid, so dozens of
transitive versions legitimately differ. Only *direct* dependencies resolving
differently indicates a real problem. Don't try to enforce byte-level parity.

**Longer-term option:** [Renovate](https://docs.renovatebot.com/modules/manager/bun/)
supports bun natively, including `vulnerabilityAlerts` for security-driven PRs.
Switching to it would let the repo drop `package-lock.json` entirely and remove
this whole class of drift. That is a deliberate change of dependency bot, not
something to do incidentally.

### Runtime Version Policy

**Floor**: Node 20 (in maintenance LTS through April 2026), Bun 1.2.21.
Both are declared in `package.json#engines`.

**Why Node 20 and not higher**: no production dep requires more, and bumping
the floor strands users on otherwise-supported LTS lines. Forced to 20 by
`@hono/node-server@2` in v1.8.2.

**CI strategy**:
- Bun is pinned (`BUN_VERSION` env in every workflow) so a Bun release can't
  silently break us. Bump in lockstep when upgrading.
- `publish.yml` builds under Node 20 (the floor) so any unsafe API call that
  only exists on newer Node breaks the build before reaching users.
- `ci.yml` has a `node-smoke` matrix (`[20, 22, 24]`) that runs the built
  binary under each currently-relevant Node line.

**When to bump the floor**: only when a real dep forces it. Update
`package.json#engines.node`, `publish.yml` Node version, the `node-smoke`
matrix floor, the README prereqs line, and call it out as breaking in the
CHANGELOG.

### Claude CLI Version Requirements

claude-threads requires a compatible version of the Claude CLI (`@anthropic-ai/claude-code`).

The version is checked at startup against a three-tier policy
(`src/claude/version-check.ts`):

| CLI version | Behavior |
|-------------|----------|
| Below `2.0.74` (hard floor) | Error message and **exit** — the bot can't work at all |
| `>=2.0.74 <2.2.0` (verified range; latest verified: 2.1.226) | Runs normally |
| Newer 2.x above the verified range | **Warn-and-run**: startup warning + "⚠️ untested" marker in the sticky message and session headers. A new CLI minor must not take every bot down until a claude-threads release ships |
| A new major (3.x+) | Error message and **exit** — different contract, warn-and-run would be reckless |

`--skip-version-check` bypasses the hard exits (not recommended; the untested
warning is not bypassable and costs nothing). A bypassed hard exit is not
silent either: the bot warns at startup and shows an "⚠️ unsupported" marker
next to the CLI version in the sticky message and session headers.

To install the latest verified version:
```bash
npm install -g @anthropic-ai/claude-code@2.1.226
```

The Claude CLI version is displayed:
- At bot startup in the terminal
- In the sticky channel message status bar
- In each session's header table

**Updating the verified range:** when a new CLI minor ships, run the manual
e2e (`tests/e2e-real-cli/decision-bridge-e2e.ts`), re-capture the reference
event streams (`tests/e2e-real-cli/capture-events.ts`) and diff them against
`tests/integration/fixtures/real-cli-captures/` for dialect drift, do a live
smoke, then bump `CLAUDE_CLI_VERIFIED_RANGE` / `CLAUDE_CLI_LATEST_VERIFIED`
in `src/claude/version-check.ts` (and `CLAUDE_CLI_MIN_VERSION` /
`CLAUDE_CLI_SUPPORTED_MAJOR` only when the floor or major actually moves) in
a patch release. The untested warning is the prompt to do this, not a
permanent state.

## Development Commands

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript to dist/
bun run dev          # Run from source with watch mode
bun start            # Run compiled version
bun test             # Run unit tests (~3000 tests)
bun run lint         # Run ESLint
```

### Integration Tests

Integration tests run the actual bot against a real Mattermost instance (or
the local Slack mock server) with a mock Claude CLI.

**The mock speaks the modern CLI dialect** (`tests/integration/fixtures/mock-claude/runner.ts`),
written against verbatim captures of the real CLI in
`tests/integration/fixtures/real-cli-captures/` (see its README; re-capture
with `tests/e2e-real-cli/capture-events.ts` when a new CLI ships). Faithful
behaviors: `system/init` + `rate_limit_event` at startup, tool results as
`tool_result` blocks in `user` events, TaskCreate/TaskUpdate task tracking
(ids resolve via "Task #N created successfully"), one `result` per turn with
the process staying alive, SIGINT → abort events then exit. In interactive
mode the mock spawns the **real MCP permission server** from `--mcp-config`
and blocks ExitPlanMode/AskUserQuestion on `permission_prompt` — so the
integration suite exercises the production permission-prompt → decision
bridge → reaction-UI path end to end. Scenarios are turn-based step DSL
JSON (`scenarios/*.json`); `exitAtEnd: true` is a documented divergence for
suites that assert session end.

```bash
# Run locally (requires Docker)
bun run test:integration:setup    # Start Mattermost in Docker + create users/channels
bun run test:integration:run      # Run ~150 integration tests
bun run test:integration:teardown # Stop Mattermost

# Or run all at once (CI style)
bun run test:integration

# No Docker? The Slack platform path needs none:
bun run test:integration:slack
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

Releases are automated via GitHub Actions. There are two paths, and both end in an
npm publish:

1. **Version bump lands on `main` → `.github/workflows/release.yml`** verifies the
   tree, creates the tag, creates the GitHub release, and publishes. This needs no
   local machine and no `gh` CLI — merging the version-bump commit is enough.
2. **You create a release by hand with `gh release create`** → the existing
   `.github/workflows/publish.yml` fires on `release: published` and publishes.

### Automated Release Flow (no local machine needed)

Everything here can be done from the GitHub web UI or by an agent that can only
push branches and merge PRs:

```
1. Open a PR that:
   a. Bumps the version in package.json with the semver level the change
      warrants — fixes only → `npm version patch`, a new feature → `npm version
      minor`, a breaking change → `npm version major` (all with
      --no-git-tag-version). `npm version` also updates package-lock.json; run
      `bun install` afterwards so bun.lock stays in lockstep (bun.lock does not
      record the root version, so it is usually a no-op — see the lockfile note
      above).
   b. Promotes the CHANGELOG's `## [Unreleased]` heading to
      `## [X.Y.Z] - YYYY-MM-DD` (the new version and today's date), so the
      release notes match the tag.
2. Merge it to main once CI is green.
3. release.yml picks up the package.json change, re-runs typecheck/lint/knip/
   tests/build, then tags, releases and publishes.
```

The bump must land as a **new** version: release.yml exits without publishing if
the current version's tag already exists, so re-using a version that was already
released (e.g. leaving package.json unchanged) is a silent no-op, not a release.

`release.yml` is safe to re-run and safe against unrelated `package.json` edits:
if the tag for the current version already exists it exits before tagging or
publishing. It also exposes `workflow_dispatch`, so a release can be kicked off
from the Actions tab (or the API) if the push trigger was missed — for example
when the version bump reached `main` before the workflow existed.

> **Why `release.yml` publishes directly instead of handing off to `publish.yml`:**
> a release created with `GITHUB_TOKEN` does not emit a `release: published` event
> that can start another workflow — GitHub suppresses those to avoid recursive
> runs. A tag-and-release-only job would therefore create the release and then
> never publish. The alternative is a long-lived PAT; publishing in-job avoids
> that credential entirely.

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
git add package.json package-lock.json && git commit -m "X.Y.Z" && git tag vX.Y.Z

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
git add package.json package-lock.json && git commit -m "X.Y.Z" && git tag vX.Y.Z

# 5. Push to GitHub with tags
git push && git push --tags

# 6. Create GitHub release (this triggers automatic npm publish)
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

**GitHub Actions Workflow:** `.github/workflows/publish.yml`
- Triggered on: GitHub release published
- Builds TypeScript and publishes to the npm registry
- Requires `NPM_TOKEN` secret in repository settings

**⚠️ IMPORTANT: NEVER modify `publish.yml`'s trigger!**
- The workflow MUST trigger on `release: types: [published]`
- NEVER change it to trigger on tag pushes
- This is the path for a release a human creates via `gh release create`
- This is the preferred manual release workflow - do not change it
- Automating a release is done in `release.yml` instead, which is a *separate*
  workflow — never by retargeting this one

**Both workflows publish, but they cannot double-publish silently:** `release.yml`
skips entirely when the current version's tag already exists, and npm refuses to
republish a version that is already on the registry, so a redundant run fails
loudly rather than shipping anything unexpected.

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
- **Directory change**: `!cd /some/path` (restarts Claude CLI — native `/cd` is not available over stream-json as of CLI 2.1.226, verified empirically)
- **Model / effort switch**: `!model sonnet`, `!effort high` (forwarded as slash commands; session header shows the current model on the next turn)
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
| Persistent memory (channel + repo layers) | `~/.config/claude-threads/memory/` | Until removed by `!memory forget` / manual delete (no automatic expiry) | `0600` files, `0700` dirs |

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
- `assistant` → `AppendContentOp` (text response); its `tool_use` blocks → `AppendContentOp` (tool display) or special ops (`TaskCreate`/`TaskUpdate` → `TaskListOp` via the per-session `TaskTracker`, `AskUserQuestion` → QuestionOp, `ExitPlanMode` → ApprovalOp, `Task` → SubagentOp, `TodoWrite` → TaskListOp)
- `user` → `AppendContentOp` result indicators (`↳ ✓`/`↳ ❌`) for its `tool_result` blocks + `FlushOp`; also resolves pending `TaskCreate` ids from result text
- `result` → `FlushOp` + `StatusUpdateOp` (cost info)
- `rate_limit_event` → consumed in `cli.ts` (`status: "rejected"` feeds account cooldown)
- `system/status` + `system/compact_boundary` → compaction lifecycle post in the thread (in-progress → success with pre→post token counts, or failure via `compact_result: "failed"` — which emits **no** boundary)
- `auth_status` → warning post when it carries an `error`; log-only otherwise (shape from the Agent SDK types — not provocable in a healthy environment)
- Events with `parent_tool_use_id` (subagent sidechains) are skipped
- Top-level `tool_use`/`tool_result` events are a legacy shape (kept for old captures and the integration mock CLI)

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
