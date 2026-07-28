# Configuration Reference

Configuration is stored at `~/.config/claude-threads/config.yaml`.

## Full Example

```yaml
version: 1
workingDir: /home/user/repos/myproject
chrome: false
worktreeMode: prompt
respondOnlyWhenMentioned: false

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
    skipPermissions: false

  # Slack
  - id: slack-eng
    type: slack
    displayName: Engineering
    botToken: xoxb-your-bot-token
    appToken: xapp-your-app-token
    channelId: C0123456789
    botName: claude
    allowedUsers: [alice, bob]
    skipPermissions: false
```

## Global Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `workingDir` | Default working directory for Claude | Current directory |
| `chrome` | Enable Chrome integration | `false` |
| `worktreeMode` | Git worktree mode: `off`, `prompt`, or `require` | `prompt` |
| `respondOnlyWhenMentioned` | Start new threads in quiet mode, where the bot only replies to messages that @mention it. Users can still toggle per-thread with `!mentions`. | `false` |
| `arbiter` | Completion watchdog. After each turn: reminds the agent about external deliveries it forgot (a `send_dm`/`send_file` the user asked for, max 2 reminders then a warning post), and nudges it to continue when it stalls asking "should I proceed?" (max 3 nudges per session; genuine blocking questions are left to humans). Uses out-of-band Haiku calls. | `true` |
| `arbiterPolicy` | What the arbiter does when a session is parked waiting on a human and nobody answers — see [Arbiter policy](#arbiter-policy) below. | see below |
| `returnDelivery` | Guaranteed reply to the requester's thread. When an incoming message carries a reply-to directive with a permalink ("отвечай мне в тред: `<url>`" / "reply in the thread: `<url>`"), the bot records that thread as the session's return address and — once the session has been quiet for 90s — posts the final assistant message there itself, mentioning the requester and linking back to its own thread. Purely deterministic, no LLM. If the agent already posted to that thread on its own, the bot stays out of the way. | `true` |
| `docsPing` | Tells a docs bot about shipped changes — see [Docs ping](#docs-ping) below. | off |

### Arbiter policy

When an agent asks something and nobody replies, the session used to sit there
forever: a pending question is exactly the case the arbiter refused to touch,
on the reasoning that "a human should answer this". In an unattended channel
that is indistinguishable from the task dying.

So the wait now has a clock. After `waitTimeoutMs` of silence a judge decides
whether the prompt genuinely needs a person. Routine, reversible choices
(send the MR for review, pick between equivalent options, continue agreed
work) get answered by the arbiter, announced in the thread and reversible by a
reply. Anything destructive, costly, irreversible, or a real product call gets
escalated to the humans instead — a `@mention` ping carrying the question and
repeated with doubling backoff.

```yaml
arbiterPolicy:
  autoAnswer: true            # answer routine prompts; false = only ever ping
  waitTimeoutMs: 600000       # 10 min of silence before stepping in
  escalateIntervalMs: 1800000 # 30 min between pings, doubling each time
  maxEscalations: 3           # then stop nagging
  escalateTo: [maxk]          # defaults to whoever started the session
  judgeModel: sonnet          # haiku is cheaper but worse at this call
```

`escalateTo` matters for bot-to-bot work: without it the ping goes to the
agent that handed the task over, which may be just as stuck. Naming a human
routes it to someone who can actually unblock things.

### Docs ping

For fleets with a dedicated documentation bot. When a session opens an MR, the
bot decides whether the change is something the docs team needs to hear about
and, if so, posts a summary into the docs bot's channel itself.

The split matters: the **trigger** and the **delivery** are code — a session
either has an MR or it doesn't, and the post either happened or it didn't. Only
the judgement ("does this touch documentation?") is a model call, made
out-of-band once per session. Asking the agent to remember this last step
doesn't work: forty minutes into a task, it doesn't.

```yaml
docsPing:
  enabled: true
  channelId: C0123DOCS       # docs bot's channel — required
  botName: april             # used in the message and for the self-ping guard
  judgeModel: sonnet
  quiescenceMs: 120000       # quiet period before the ping fires
```

Nothing fires for a session without an MR, the docs bot never pings itself
(guarded by both name and channel), and if the agent already posted to that
channel — because a human asked it to — the bot stays out of the way.

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
| `skipPermissions` | No | Auto-approve actions (default: `false`) |
| `sessionHeader` | No | Per-thread header visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no header post) |
| `stickyMessage` | No | Channel sticky visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no sticky, no bumping) |

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
| `skipPermissions` | No | Auto-approve actions (default: `false`) |
| `sessionHeader` | No | Per-thread header visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no header post) |
| `stickyMessage` | No | Channel sticky visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no sticky, no bumping) |

### Quieting the bot's overhead messages

Both the per-thread session header and the channel sticky message default to `full` for backward compatibility. To strip them down on a noisy channel, set the per-platform fields in `config.yaml`:

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... credentials ...
    sessionHeader: hidden    # no header post — Claude's reply is the first message in the thread
    stickyMessage: minimal   # one-line status bar at the channel bottom, no sessions list
```

Note: the per-platform `stickyMessage: <mode>` field is distinct from the top-level `Config.stickyMessage: { description, footer }` block, which still customizes the full sticky for platforms not in `hidden` mode.

## Claude Accounts (optional, multi-account mode)

By default every session spawns `claude` with the bot's own `process.env`, so they all share one subscription's token budget. Add a `claudeAccounts` block to spread load across multiple accounts — the bot round-robins new sessions across the pool and automatically skips accounts in rate-limit cooldown. Omit the block entirely to stay in single-account mode (unchanged behavior).

```yaml
claudeAccounts:
  # OAuth accounts — prepare each HOME first with `HOME=<path> claude login`
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
| `MAX_SESSIONS` | Max concurrent sessions | `5` |
| `SESSION_TIMEOUT_MS` | Idle timeout in milliseconds | `1800000` (30 min) |
| `NO_UPDATE_NOTIFIER` | Disable update checks | - |
| `DEBUG` | Enable verbose logging | - |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Strip `ANTHROPIC_*` / `AWS_*_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / `GOOGLE_APPLICATION_CREDENTIALS` etc. from Bash, hook, and stdio-MCP subprocesses Claude spawns. Bot-specific vars like `PLATFORM_TOKEN` pass through. **Also forces permission mode to `default`** — `--dangerously-skip-permissions` will be rejected. Requires Claude CLI 2.1.83+. | - |

### Forwarded to Claude CLI automatically

The bot sets two tuning flags on the Claude child process when they aren't
already present in the bot's environment:

| Variable | Effect | Requires |
|----------|--------|----------|
| `MCP_CONNECTION_NONBLOCKING=true` | Caps `--mcp-config` connects at 5s so a slow MCP server never delays startup | Claude CLI 2.1.89+ |
| `ENABLE_PROMPT_CACHING_1H=true` | Opts into 1-hour prompt cache TTL, cutting re-caching cost on long-lived threads | Claude CLI 2.1.108+ |

Export either with a different value in the bot's own env to disable.

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
  --skip-permissions       Skip permission prompts (auto-approve)
  --no-skip-permissions    Enable permission prompts (override env)
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
