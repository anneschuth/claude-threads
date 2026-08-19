# Configuration Reference

Configuration is stored at `~/.config/claude-threads/config.yaml`.

## Full Example

```yaml
version: 1
workingDir: /home/user/repos/myproject
chrome: false
worktreeMode: prompt
respondOnlyWhenMentioned: false
userAttribution: true

platforms:
  # Mattermost
  - id: mattermost-main
    type: mattermost
    displayName: Main Team
    url: https://chat.example.com
    token: your-bot-token
    channelId: abc123
    botName: claude-code
    allowedUsers: [alice, bob]
    permissionMode: default
    memory: true                  # persistent memory (default on; see Memory below)

  # Slack
  - id: slack-eng
    type: slack
    displayName: Engineering
    botToken: xoxb-your-bot-token
    appToken: xapp-your-app-token
    channelId: C0123456789
    botName: claude
    allowedUsers: [alice, bob]
    permissionMode: default
```

## Global Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `version` | Config schema version | `1` |
| `workingDir` | Default working directory for Claude | Current directory |
| `chrome` | Enable Chrome integration | `false` |
| `worktreeMode` | Git worktree mode: `off`, `prompt`, or `require` | `prompt` |
| `respondOnlyWhenMentioned` | Start new threads in quiet mode, where the bot only replies to messages that @mention it. Users can still toggle per-thread with `!mentions`. | `false` |
| `userAttribution` | Prefix each user turn sent to Claude with the sender's `[@username]:` so Claude can tell who is speaking in multi-user threads. Only applied once a thread has more than one participant (after `!invite`); solo threads are left untouched. Set `false` to disable. Applies to new sessions. | `true` |
| `keepAlive` | Prevent system sleep while sessions are active | `true` |
| `limits` | Resource limits and timeouts (see below) | see below |
| `threadLogs` | Thread logging (see below) | enabled |
| `stickyMessage` | Sticky message text customization (see below) | none |
| `claudeAccounts` | Multi-account pool (see below) | single-account mode |

### Resource Limits (`limits`)

Every field is optional and falls back to the default. Older `config.yaml` files predate most of these, so leaving the block out is fine.

```yaml
limits:
  maxSessions: 5
  sessionTimeoutMinutes: 30
  sessionWarningMinutes: 5
  cleanupIntervalMinutes: 60
  maxWorktreeAgeHours: 24
  cleanupWorktrees: true
  permissionTimeoutSeconds: 120
  flushDelayMs: 500
```

| Setting | Description | Default |
|---------|-------------|---------|
| `maxSessions` | Maximum concurrent sessions | `5` |
| `sessionTimeoutMinutes` | Idle timeout before a session auto-terminates | `30` |
| `sessionWarningMinutes` | Warn the user this many minutes before timeout | `5` |
| `cleanupIntervalMinutes` | How often the background cleanup runs | `60` |
| `maxWorktreeAgeHours` | Clean up orphaned worktrees older than this | `24` |
| `cleanupWorktrees` | Enable automatic cleanup of orphaned worktrees | `true` |
| `permissionTimeoutSeconds` | How long a permission prompt waits for a reaction | `120` |
| `flushDelayMs` | Delay before flushing batched output to the platform. Lower is snappier with more API calls; higher posts less often with coarser streaming. | `500` |

The legacy env vars `MAX_SESSIONS` and `SESSION_TIMEOUT_MS` still work as fallbacks when `limits.maxSessions` / `limits.sessionTimeoutMinutes` are unset. See [Environment Variables](#environment-variables).

### Thread Logs (`threadLogs`)

```yaml
threadLogs:
  enabled: true
  retentionDays: 30
```

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Write per-thread session logs to disk | `true` |
| `retentionDays` | Delete logs this many days after a session ends | `30` |

### Sticky Message Text (`stickyMessage`)

Customize the text of the channel sticky message. This is distinct from the per-platform `stickyMessage: <mode>` visibility field documented under [Platform Settings](#platform-settings).

```yaml
stickyMessage:
  description: "Porygon — Mixpanel analytics bot"
  footer: "• !stop — End session\n• !help — Show help"
```

| Setting | Description | Default |
|---------|-------------|---------|
| `description` | Line shown below the sticky title | none |
| `footer` | Content shown before the default "Mention me to start a session" line | none |

## Platform Settings

### Mattermost

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Unique identifier for this platform |
| `type` | Yes | Must be `mattermost` |
| `displayName` | No | Human-readable name |
| `url` | Yes | Mattermost server URL |
| `token` | Yes | Bot access token |
| `channelId` | Yes | Channel to listen in |
| `botName` | No | Mention name (default: `claude-code`) |
| `allowedUsers` | No | List of usernames who can use the bot |
| `permissionMode` | No | How tool-use is gated: `default` / `auto` / `bypass` (default: `default`). See [Permission Modes](#permission-modes). |
| `skipPermissions` | No | **Deprecated.** Use `permissionMode`. `true` maps to `bypass`, `false` to `default`. `permissionMode` wins when both are set. |
| `outboundFiles` | No | `send_file` settings: `{ enabled, maxBytes }` (defaults: enabled `true`, `maxBytes` 100 MB) |
| `sessionHeader` | No | Per-thread header visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no header post) |
| `stickyMessage` | No | Channel sticky visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no sticky, no bumping) |
| `directChannelMode` | No | Direct channel mode: the whole channel is one session, and the bot replies with top-level channel posts instead of thread replies. `true` for defaults, or an options object (`respondTo`). See [Direct Channel Mode](#direct-channel-mode). |
| `approvals` | No | Who may answer tool-permission prompts and other reaction gates: `owner` (session participants) or `all_users` (everyone on `allowedUsers`). Unset keeps the historical default per mode — `all_users` for thread sessions, `owner` for direct channel mode. See [Approvals](#approvals). |

### Slack

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Unique identifier for this platform |
| `type` | Yes | Must be `slack` |
| `displayName` | No | Human-readable name |
| `botToken` | Yes | Bot User OAuth Token (`xoxb-...`) |
| `appToken` | Yes | App-Level Token for Socket Mode (`xapp-...`) |
| `channelId` | Yes | Channel ID (e.g., `C0123456789`) |
| `botName` | No | Mention name (default: `claude`) |
| `allowedUsers` | No | List of Slack usernames |
| `permissionMode` | No | How tool-use is gated: `default` / `auto` / `bypass` (default: `default`). See [Permission Modes](#permission-modes). |
| `skipPermissions` | No | **Deprecated.** Use `permissionMode`. `true` maps to `bypass`, `false` to `default`. `permissionMode` wins when both are set. |
| `outboundFiles` | No | `send_file` settings: `{ enabled, maxBytes }` (defaults: enabled `true`, `maxBytes` 100 MB) |
| `sessionHeader` | No | Per-thread header visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no header post) |
| `stickyMessage` | No | Channel sticky visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no sticky, no bumping) |
| `directChannelMode` | No | Direct channel mode: the whole channel is one session, and the bot replies with top-level channel posts instead of thread replies. `true` for defaults, or an options object (`respondTo`). See [Direct Channel Mode](#direct-channel-mode). |
| `approvals` | No | Who may answer tool-permission prompts and other reaction gates: `owner` (session participants) or `all_users` (everyone on `allowedUsers`). Unset keeps the historical default per mode — `all_users` for thread sessions, `owner` for direct channel mode. See [Approvals](#approvals). |

### Direct Channel Mode

`directChannelMode: true` turns the configured channel into a single, always-on conversation with the bot:

- Every message in the channel reaches the bot — no `@mention` required (messages starting with `@someone-else` are still treated as side conversations and ignored).
- The bot replies with **top-level channel posts** instead of thread replies, so the channel reads like a plain chat.
- Only **one session** exists per platform instance; internally it is keyed by the synthetic thread id `dcm:<platform id>`, so persistence, resume after bot restarts, emoji permission prompts, and `!commands` all work exactly as in thread sessions.
- Messages posted inside any thread of the channel are routed to the same session.

This is the mode to use for a dedicated channel with the bot (see issue #315). For shared channels where multiple parallel sessions are wanted, keep the default thread-per-session behavior.

The long form configures how the shared channel behaves:

```yaml
directChannelMode:
  respondTo: all_messages   # or: mention
```

| Option | Values | Default | Meaning |
|--------|--------|---------|---------|
| `respondTo` | `all_messages` / `mention` | `all_messages` | `all_messages`: every message from an allowed user reaches the bot. `mention`: the bot only reacts to messages that @mention it — useful when several people discuss in the channel and the bot should not join every exchange. Backed by the per-session quiet-mode flag, so `!mentions` toggles it at runtime. |

Who may approve tool use in the channel is controlled by the platform-level [`approvals`](#approvals) option (DCM defaults to `owner`).

### Approvals

The platform-level `approvals` option controls who may answer tool-permission prompts (👍/✅/👎) and the other reaction gates — plan approvals, question answers, and session resume:

- `owner` — the session participants: the starter plus explicitly `!invite`d users.
- `all_users` — everyone on the platform's `allowedUsers` list.

Unset keeps the historical default per mode, so existing setups are unaffected: thread sessions behave as before (`all_users`), direct channel mode defaults to the safer `owner`. Setting the option applies it to every session of that platform entry — including classic thread sessions, where `approvals: owner` is an opt-in hardening.

The approval set is fixed when the Claude CLI is spawned; a later `!invite` extends message access immediately but reaches the approval set on the next CLI respawn (e.g. via `!cd` or `!permissions`).

### Direct messages (DM)

**Mattermost only.** A Mattermost DM is just a private channel with its own id, so a bot DM conversation is direct channel mode pointed at that id — no separate feature needed. (This recipe does NOT work on Slack: Socket Mode distributes event envelopes across an app's active connections, so a second platform entry sharing the same app credentials can consume and discard events meant for the other entry. Slack DM support needs a single-connection, channel-aware implementation.)

```yaml
platforms:
  - id: mattermost-dm
    type: mattermost
    url: https://chat.example.com
    token: your-bot-token       # same bot token as the main entry
    channelId: <dm-channel-id>
    botName: claude-code
    directChannelMode: true
    stickyMessage: hidden       # a sticky makes little sense in a DM
    allowedUsers: [you]
```

Get the DM channel id with one API call: `POST /api/v4/channels/direct` with `["<bot-user-id>", "<your-user-id>"]` — the returned `id` is stable.

Limitations: the thread-context prompt ("include previous messages?") is skipped — there is no thread history to offer — and the `list_thread` MCP tool cannot resolve the synthetic session id (use `read_channel_history` instead).

### Permission Modes

The `permissionMode` field controls how the bot handles a session's tool-use requests.

| Mode | Behavior |
|------|----------|
| `default` | Every tool-use prompts for approval. The bot posts a permission request in the thread and the user reacts 👍 (allow once) / ✅ (allow all) / 👎 (deny). Safest option. |
| `auto` | Claude's built-in classifier decides per tool: low-risk actions are auto-approved, high-risk ones still prompt. Requires Claude CLI 2.1.x. |
| `bypass` | No prompts and no classifier. Every tool-use is allowed. Equivalent to `--dangerously-skip-permissions`. This is what the legacy `skipPermissions: true` maps to. |

A running session can switch mode at any time with `!permissions <mode>`; that override is not persisted across a bot restart.

### Quieting the bot's overhead messages

Both the per-thread session header and the channel sticky message default to `full` for backward compatibility. To strip them down on a noisy channel, set the per-platform fields in `config.yaml`:

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... credentials ...
    sessionHeader: hidden    # no header post, Claude's reply is the first message in the thread
    stickyMessage: minimal   # one-line status bar at the channel bottom, no sessions list
```

Note: the per-platform `stickyMessage: <mode>` field is distinct from the top-level `Config.stickyMessage: { description, footer }` block, which still customizes the full sticky for platforms not in `hidden` mode.

### Memory (`memory`, default: fully enabled)

Each platform instance (≈ one channel) can carry persistent memory, modeled on
how Anthropic's own products do it:

- **Repo layer** (Claude Code style): Claude Code's native *auto-memory* is
  redirected into a bot-managed directory scoped per **(platform, repository)**.
  Claude saves and recalls project knowledge (build commands, conventions,
  gotchas) across sessions in the same repo, using its built-in memory
  machinery — worktrees of one repo share the same memory, mirroring native
  behavior. Requires Claude CLI 2.1.235+ (the `autoMemoryDirectory` setting).
- **Channel layer** (Claude Tag style): a shared per-channel `MEMORY.md` of
  team notes — decisions, conventions, stable facts — injected into every
  session's system prompt (capped at 200 lines / 25 KB, mirroring native
  limits). Written by users (`!remember`) and by end-of-session
  **distillation**: when a session ends, a one-shot haiku pass extracts up to
  3 durable facts from the thread.

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... credentials ...
    memory: true                # default — everything on; `false` disables all layers
    # or per-layer:
    # memory:
    #   repoLayer: true         # native auto-memory redirect
    #   channelLayer: true      # shared channel notes in the system prompt
    #   distillation: false     # no end-of-session haiku pass
```

**Commands** (any session-authorized user; `forget` is owner-gated):

- `!remember <text>` — save a note to the channel's shared memory
- `!memory` — show the channel memory as a numbered list
- `!memory forget <n|text>` — remove one entry; `!memory forget all` clears it

**Storage & privacy:**

- Everything lives under `~/.config/claude-threads/memory/` (override with
  `CLAUDE_THREADS_MEMORY_DIR`), dirs `0700` / bot-written files `0600`.
- **The platform instance is a hard privacy boundary**: memory never crosses
  platform instances, even for the same repository — mirroring Claude Tag's
  per-channel isolation. The storage location is also independent of the
  Claude-account pool's per-session `HOME` overrides.
- When memory is disabled, the bot also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
  on the Claude CLI child so native auto-memory can't silently accumulate
  cross-channel context under a shared pooled-account `$HOME`.
- `!memory forget` removes the entry atomically for all **future** sessions;
  sessions already running keep their injected copy until their next
  respawn/resume. Repo-layer files are owned by the Claude CLI — ask Claude
  in-session to update its memory, or delete the directory on disk.
- Channel memory is chat-derived content that persists into future sessions'
  prompts. The system-prompt framing tells Claude to treat it as background
  context — never as instructions or authorization — but memory is only as
  trusted as the channel's membership. Distillation currently reads the whole
  thread, including messages from non-allowed users that entered via the
  approval flow. There is no automatic expiry. Both are candidates for
  follow-up options.
- Distillation runs one `claude -p` haiku call per session end, billed to the
  bot's default account (not the session's pooled account). In an OAuth
  `claudeAccounts` pool where only the per-account HOMEs are logged in, the
  bot's own environment may have no credentials — distillation then fails
  silently (debug-logged) and the channel only learns via `!remember`. Give
  the bot process its own credentials (`claude login` under the bot's HOME,
  or `ANTHROPIC_API_KEY` in its env) if you want distillation in that setup.
- Note for exotic setups: the Claude CLI disables auto-memory when
  `CLAUDE_CODE_REMOTE` is set (unless `CLAUDE_CODE_REMOTE_MEMORY_DIR` is
  configured) — the repo layer will be inert in such environments.

### Routines (`routines`, default: enabled)

Scheduled recurring work, Claude Tag-style: a routine fires on its schedule
as a **bot-initiated session thread** in the channel — a completely normal
session (platform permission mode, account-pool balancing, channel memory,
distillation) whose task is the routine's prompt.

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... credentials ...
    routines: true              # default; `false` disables the scheduler + commands

limits:
  maxRoutines: 10               # per-platform cap (default 10)
```

**Creating** (natural language, confirmed before saving):

```
!routine every weekday at 9am, summarize the open review threads
```

A haiku pass parses the request into a structured schedule (presets: hourly /
daily / weekdays / weekly — hourly is the floor), the bot posts the parsed
result, and **nothing is saved until someone reacts 👍**. Timezones: name one
explicitly ("9am Pacific"); otherwise the bot host's timezone is used and the
confirmation says so.

**Managing:**

- `!routines` — numbered list with schedule, creator, and last-run status
- `!routines pause|resume|delete <n>` — owner-gated
- `!routines run <n>` — fire now, outside the schedule (platform-allowed
  users only — not temporarily `!invite`d guests; does not consume the
  period's scheduled fire)

**Semantics & guardrails:**

- Runs fire **as their creator** and are re-authorized on every fire — a
  creator who loses platform authorization disables the routine (with a
  channel notice), mirroring Claude Tag.
- At most one fire per period (hour/day/week), evaluated on the wall clock in
  the routine's timezone (DST-safe). A window missed entirely (bot offline)
  is skipped, not back-filled.
- 3 consecutive failed runs auto-disable the routine with a channel notice;
  `!routines resume <n>` re-arms it.
- Runs count against `MAX_SESSIONS`; at the limit a fire is retried within
  its window and otherwise skipped.
- **Each run starts a full Claude session on your subscription** — the
  confirmation and `!routines` listing both say so.
- Routines are scoped per platform instance (same privacy boundary as
  memory) and stored at `~/.config/claude-threads/routines.yaml` (0600;
  override with `CLAUDE_THREADS_ROUTINES_PATH`).
- The natural-language parse uses one haiku `claude -p` call — the same
  bot-process-credentials caveat as memory distillation applies in OAuth
  account pools.

## Claude Accounts (optional, multi-account mode)

By default every session spawns `claude` with the bot's own `process.env`, so they all share one subscription's token budget. Add a `claudeAccounts` block to spread load across multiple accounts. Omit the block entirely to stay in single-account mode (unchanged behavior).

Selection is usage-balanced (since v1.18.0). At each new-session start the bot probes every account's live limits with `claude -p "/usage" --output-format json` under that account's `HOME` (costs nothing, uses no turns) and routes the session to the account with the most subscription headroom, meaning the lowest `max(session%, week%)`. Round-robin is only the fallback when probing yields no usable numbers (for example an API-key account, which reports no percentages). Accounts in rate-limit cooldown are skipped until their reset time. A resumed session always re-binds to the account its history lives under, cooling or not.

```yaml
claudeAccounts:
  # OAuth accounts (prepare each HOME first with `HOME=<path> claude login`)
  - id: primary
    home: /home/bot/.claude-accounts/primary
  - id: backup
    displayName: Backup (Pro)
    home: /home/bot/.claude-accounts/backup

  # API-key billed
  - id: shared-api
    apiKey: sk-ant-api03-xxxxxxxx...
```

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Stable identifier used in logs, UI, and persisted session state |
| `home` | One of | Alternate `$HOME` containing `.claude/.credentials.json` from a prior `HOME=<path> claude login`. For OAuth Pro/Max subscriptions. Session history also lives here, so resumed sessions pick the same account. |
| `apiKey` | One of | Anthropic API key. Billed against that key; session history stays under the bot's default `HOME`. |
| `displayName` | No | Human-readable label in UI (defaults to `id`) |

Exactly one of `home` or `apiKey` should be set per account. Persisted sessions record which account they ran under and resume on the same one.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_SESSIONS` | Max concurrent sessions. Legacy fallback for `limits.maxSessions`. | `5` |
| `SESSION_TIMEOUT_MS` | Idle timeout in milliseconds. Legacy fallback for `limits.sessionTimeoutMinutes`. | `1800000` (30 min) |
| `DEBUG` | Enable verbose logging | - |
| `CLAUDE_PATH` | Path to the `claude` binary. Overrides the PATH lookup and the common install locations. | `claude` (from PATH) |
| `DECISION_BRIDGE_TIMEOUT_MS` | How long the MCP permission server waits for a plan approval or question answer routed through the decision bridge (the bot's reaction UI) before falling back to the legacy behavior (generic prompt for plans, auto-allow for questions). | `3600000` (1 h) |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Strip `ANTHROPIC_*`, `AWS_*_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, and similar from Bash, hook, and stdio-MCP subprocesses Claude spawns. Bot-specific vars like `PLATFORM_TOKEN` pass through. **Also forces permission mode to `default`**; `--dangerously-skip-permissions` will be rejected. Requires Claude CLI 2.1.83+. | - |
| `CLAUDE_THREADS_SESSIONS_PATH` | Override the path to the persisted sessions file (default `~/.config/claude-threads/sessions.json`). | - |
| `CLAUDE_THREADS_GITHUB_EMAILS_PATH` | Override the path to the GitHub-emails store used for commit attribution. | - |
| `CLAUDE_THREADS_MEMORY_DIR` | Override the root of the persistent memory storage (default `~/.config/claude-threads/memory/`). | - |
| `NO_UPDATE_NOTIFIER` | Disable update checks | - |

### Forwarded to Claude CLI automatically

The bot sets these tuning flags on the Claude child process when they aren't
already present in the bot's environment:

| Variable | Effect | Requires |
|----------|--------|----------|
| `MCP_CONNECTION_NONBLOCKING=true` | Caps `--mcp-config` connects at 5s so a slow MCP server never delays startup | Claude CLI 2.1.89+ |
| `ENABLE_PROMPT_CACHING_1H=true` | Opts into 1-hour prompt cache TTL, cutting re-caching cost on long-lived threads | Claude CLI 2.1.108+ |
| `MCP_TOOL_TIMEOUT=3600000` | Only set when the session has a decision bridge. Without it the CLI abandons a pending MCP permission call after ~2 minutes — far too short for plan approvals and question answers that wait on a human reaction. One hour matches the bridge's own `DECISION_BRIDGE_TIMEOUT_MS` default. Verified against CLI 2.1.223. | — |

Export any of them with a different value in the bot's own env to override.

## CLI Options

CLI options override config file settings:

```bash
claude-threads [options]

Options:
  --url <url>              Mattermost server URL
  --token <token>          Bot token
  --channel <id>           Channel ID
  --bot-name <name>        Bot mention name (default: claude-code)
  --allowed-users <list>   Comma-separated allowed usernames
  --permission-mode <mode> Permission mode: default | auto | bypass
  --skip-permissions       [deprecated] Alias for --permission-mode bypass
  --no-skip-permissions    [deprecated] Alias for --permission-mode default
  --chrome                 Enable Chrome integration
  --no-chrome              Disable Chrome integration
  --worktree-mode <mode>   Git worktree mode: off, prompt, require
  --session-header <mode>  Per-thread header: full | minimal | hidden (overrides per-platform config)
  --sticky-message <mode>  Channel sticky: full | minimal | hidden (overrides per-platform config)
  --setup                  Re-run setup wizard
  --debug                  Enable debug logging
  --version                Show version
  --help                   Show help
```

## Session Persistence

Active sessions are saved to `~/.config/claude-threads/sessions.json` and automatically resume after bot restarts.

## Keep-Alive

The bot prevents system sleep while sessions are active (uses `caffeinate` on macOS, `systemd-inhibit` on Linux). Disable with `--no-keep-alive` or `keepAlive: false` in config.

---

_claude-threads is maintained by [Axolotl Systems](https://axolotl.systems). If it makes your team faster, consider [sponsoring the project](https://github.com/sponsors/axolotl-systems)._
