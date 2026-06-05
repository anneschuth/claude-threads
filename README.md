# Claude Threads

```
 ✴ ▄█▀ ███ ✴   claude-threads
✴  █▀   █   ✴  Mattermost & Slack × Claude Code
 ✴ ▀█▄  █  ✴
```

<p align="center">
  <a href="https://claude-threads.run"><strong>claude-threads.run</strong></a>
</p>

[![npm version](https://img.shields.io/npm/v/claude-threads.svg)](https://www.npmjs.com/package/claude-threads)
[![npm downloads](https://img.shields.io/npm/dm/claude-threads.svg)](https://www.npmjs.com/package/claude-threads)
[![CI](https://github.com/anneschuth/claude-threads/actions/workflows/ci.yml/badge.svg)](https://github.com/anneschuth/claude-threads/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/anneschuth/4951f9235658e276208942986092e5ab/raw/coverage-badge.json)](https://github.com/anneschuth/claude-threads/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node](https://img.shields.io/node/v/claude-threads.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/anneschuth/claude-threads/pulls)

**Bring Claude Code to your team.** Run Claude Code on your machine, share it live in Mattermost or Slack. Colleagues can watch, collaborate, and run their own sessions—all from chat.

> _Think of it as screen-sharing for AI pair programming, but everyone can type._

## Features

- **Real-time streaming** - Claude's responses stream live to chat
- **Multi-platform** - Connect to multiple Mattermost and Slack workspaces simultaneously
- **Concurrent sessions** - Each thread gets its own Claude session, persisted across bot restarts
- **Collaboration** - `!invite` teammates to participate; they get added as `Co-Authored-By:` trailers on Claude's commits
- **Permission modes** - Three-way control over Claude's tool-use: `default` (every action prompts for 👍/✅/👎 approval via emoji), `auto` (Claude's classifier auto-approves low-risk; high-risk still prompts — recommended), or `bypass` (no prompts, all tools allowed). Set via config, `--permission-mode` CLI flag, or in-session with `!permissions default|auto|bypass`.
- **Claude posts back to chat** - Claude can call `send_file` to drop screenshots, generated PDFs, plots, or audio directly into the thread, and `read_post` to follow a Mattermost or Slack permalink the user shares
- **Git worktrees** - Isolate Claude's changes in a branch with `!worktree feature/foo`; supports `list`, `switch`, `remove`, `cleanup`, `off`
- **File attachments** - Drop images, PDFs, archives, or any file into the chat; Claude reads them from disk via its own `Read`/Bash tools (100 MB cap)
- **Chrome automation** - Optional integration with Claude in Chrome for web tasks
- **Multi-account Claude (opt-in)** - Round-robin sessions across multiple Claude subscriptions or API keys with automatic rate-limit cooldown — see [Configuration](docs/CONFIGURATION.md#claude-accounts-optional-multi-account-mode)
- **Auto-update** - Bot checks npm for new versions and offers to restart; `!update now` / `!update defer` controls the timing

## Quick Start

### Install & Run

```bash
# Install (pick one)
bun install -g claude-threads   # with Bun (recommended)
npm install -g claude-threads   # with Node

# Run the setup wizard
cd /your/project
claude-threads
```

The **interactive setup wizard** will guide you through everything:

- Configure Claude Code CLI (if needed)
- Set up your Mattermost or Slack bot
- Test credentials and permissions
- Get you up and running in minutes

**Need help with platform setup?** See the [Setup Guide](SETUP_GUIDE.md) for Mattermost or Slack bot creation.

### Prerequisites

- **Bun 1.2.21+** or **Node 20+** - [Install Bun](https://bun.sh/) or [Install Node](https://nodejs.org/)
- **Claude Code CLI working** - test with `claude --version` (needs API key or subscription)

### Use

Mention the bot in your chat:

```
@claude help me fix the bug in src/auth.ts
```

## Session Commands

Type `!help` in any session thread:

| Command                                     | Description                                                                              |
| :------------------------------------------ | :--------------------------------------------------------------------------------------- |
| `!help`                                     | Show available commands                                                                  |
| `!release-notes`                            | Show what changed in the running version                                                 |
| `!context`                                  | Show context usage                                                                       |
| `!cost`                                     | Show token usage and cost                                                                |
| `!compact`                                  | Compress context to free up space                                                        |
| `!cd <path>`                                | Change working directory (restarts Claude)                                               |
| `!permissions <mode>`                       | Set permission mode: `default` / `auto` / `bypass`                                       |
| `!mentions [on\|off]`                       | Quiet mode: only respond when @mentioned (bare `!mentions` toggles)                      |
| `!worktree <branch>`                        | Create and switch to a git worktree (also: `list`, `switch`, `remove`, `cleanup`, `off`) |
| `!plugin <list\|install\|uninstall> [name]` | Manage Claude Code plugins (restarts Claude)                                             |
| `!invite @user`                             | Invite a user to this session (added as `Co-Authored-By:` on commits)                    |
| `!kick @user`                               | Remove an invited user                                                                   |
| `!github-email <email>`                     | Register your GitHub noreply email so `!invite` can attribute commits to you             |
| `!update`                                   | Show auto-update status (`!update now` / `!update defer`)                                |
| `!bug <desc>`                               | Report a bug with context (creates a GitHub issue)                                       |
| `!approve`                                  | Approve pending plan (alternative to 👍 reaction)                                        |
| `!escape`                                   | Interrupt current task (session stays active)                                            |
| `!stop`                                     | Stop this session                                                                        |
| `!kill`                                     | Emergency shutdown (kills ALL sessions and exits the bot)                                |

## Interactive Controls

**Permission approval** - When Claude wants to execute a tool:

- 👍 Allow this action
- ✅ Allow all future actions
- 👎 Deny

**Plan approval** - When Claude creates a plan:

- 👍 Approve and start
- 👎 Request changes

**Questions** - React with 1️⃣ 2️⃣ 3️⃣ 4️⃣ to answer multiple choice

**Session control** - ⏸️ to interrupt, ❌ or 🛑 to stop, ↩️ to resume a timed-out session

## File Attachments

Drop any file into the chat (image, PDF, archive, source, log, you name it). The bot saves it to a per-thread directory and prepends the path to your message; Claude reads it with its own `Read` tool (full multimodal for images and PDFs) or processes it via Bash. Single 100 MB cap per file. Need to extract a zip? Claude runs `unzip` itself.

Going the other way, Claude can post files back into the thread (screenshots, generated PDFs, plots, MP3s) by calling the `send_file` MCP tool. Path is validated against the session working directory; auto-approved so the user doesn't have to 👍 every screenshot.

## Collaboration

```
!invite @colleague    # Let them participate
!kick @colleague      # Remove access
```

Unauthorized users can request message approval from the session owner with a 👍 reaction.

Invited collaborators are added as `Co-Authored-By:` trailers on any commits Claude makes during the session. Each collaborator runs `!github-email <their-noreply-address>` once (find yours at <https://github.com/settings/emails>) and the bot remembers it across sessions.

## Sharing Links With Claude

Paste a Mattermost or Slack permalink in the thread and Claude can resolve it to the post body (and optional thread context) via the `read_post` MCP tool, instead of asking you to copy-paste. Auto-approved; scoped to channels the bot can already see.

## Git Worktrees

Keep your main branch clean while Claude works on features:

```
@claude on branch feature/add-auth implement user authentication
```

Or mid-session: `!worktree feature/add-auth`

## Access Control

Restrict who can use the bot during setup (or reconfigure later with `claude-threads --setup`).

Leave the allowed users list empty to let anyone in the channel use the bot (be careful!)

## Documentation

- **[Setup Guide](SETUP_GUIDE.md)** - Step-by-step setup for Mattermost and Slack
- **[Configuration Reference](CLAUDE.md)** - Technical details and architecture

## Updates

```bash
npm install -g claude-threads
```

The bot checks for updates automatically and notifies you when new versions are available.

## License

Apache-2.0
