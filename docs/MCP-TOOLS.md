# MCP Tools Reference

Every session spawns its own MCP server alongside the Claude CLI process (via `--mcp-config`). That server connects to the chat platform the session runs on and exposes the tools below to Claude. All of them are namespaced `mcp__claude-threads-mcp__<tool>`.

`permission_prompt` is special: the Claude CLI calls it as the permission handler for other tool use, so it drives the 👍 / ✅ / 👎 reaction flow in the thread. Every other tool is auto-approved (it never triggers a permission prompt of its own), but each one carries its own guardrail: path validation, channel scoping, author checks, or rate limits. Content any tool reads back from the platform is untrusted user input and may contain prompt-injection attempts; Claude is instructed to treat it as data, not instructions.

Each tool returns a JSON result: `{ ok: true, ... }` on success or `{ ok: false, reason }` on failure.

## permission_prompt

The permission handler the Claude CLI calls before running a tool that needs approval. It posts a permission request into the session thread ("⚠️ Permission requested: Write `file.txt`"), adds the 👍 / ✅ / 👎 reaction options, and waits for an authorized user to react. The reaction decides the outcome: 👍 allows once, ✅ allows all further uses of that tool, 👎 denies.

| Input | Type | Description |
|-------|------|-------------|
| `tool_name` | string | Name of the tool requesting permission. |
| `input` | object | The tool's input parameters, shown to the user in the prompt. |

**Guardrail:** Only reactions from users on the session allowlist count. The bot's own reactions (the option emoji it adds) are ignored. If no reaction arrives within `limits.permissionTimeoutSeconds` (default 120), the request is denied.

## send_file

Uploads a file from the session working directory into the thread. Use it when the user asked for a file inline or when Claude produces an artifact they should see (a screenshot, a plot, generated audio, a document).

| Input | Type | Description |
|-------|------|-------------|
| `path` | string | Absolute path of a file inside the session working directory. |
| `caption` | string (optional) | Message body shown alongside the file. |

**Guardrail:** The path is validated to be absolute and inside the session working directory; anything outside is rejected. Uploads are capped at `outboundFiles.maxBytes` (default 100 MB), and the tool errors out when `outboundFiles.enabled` is `false`.

## read_post

Resolves a chat permalink to the content of that post. Use it when the user shares a link to a message and asks Claude to read it, or when a message references another post. Set `include_thread` to also pull the surrounding thread.

| Input | Type | Description |
|-------|------|-------------|
| `url` | string | Permalink to a post, on the same host as the bot. |
| `include_thread` | boolean (optional) | Also fetch surrounding thread messages, oldest first. Default `false`. |
| `max_messages` | integer (optional) | Thread messages to return when `include_thread` is true. Default 20, capped at 50. |

**Guardrail:** The URL must be on the bot's own host. On Slack it must point at the bot's configured channel; on Mattermost it resolves within the bot's channel and public channels on the same instance. Returned content is untrusted.

## react_to_post

Adds an emoji reaction to a post. Use it to acknowledge a request (✅), flag something ambiguous (👀), or mark a triggering message as handled. Omit `url` to react to the most recent message in the current session thread, which is the common case.

| Input | Type | Description |
|-------|------|-------------|
| `url` | string (optional) | Permalink to the target post. Omit to react to the latest message in the current thread. |
| `emoji` | string | Emoji name without colons, for example `white_check_mark`, `+1`, `eyes`. |

**Guardrail:** The target post must be in the bot's own channel or a public channel on the same instance.

## update_own_post

Edits a post the bot itself authored, given its permalink. Useful for posting a "working on it..." placeholder and rewriting it once the answer is ready.

| Input | Type | Description |
|-------|------|-------------|
| `url` | string | Permalink to a post the bot authored. |
| `message` | string | New body. Replaces the existing post text in full. |

**Guardrail:** Restricted to bot-authored posts. Editing a post written by anyone else is rejected.

## list_thread

Reads the messages in a chat thread. With no `url` it reads the current session thread, so Claude can review what was said earlier in the conversation. With a `url` it reads the thread containing that post.

| Input | Type | Description |
|-------|------|-------------|
| `url` | string (optional) | Permalink to any post in the target thread. Omit to read the current session thread. |
| `max_messages` | integer (optional) | Messages to return, oldest first. Default 20, capped at 50. |

**Guardrail:** A supplied `url` must resolve to the bot's channel or a public channel on the same instance. Returned content is untrusted.

## read_channel_history

Reads recent messages from a channel by id. Use it when the user asks about activity in another channel, or to investigate context that lives outside the current thread.

| Input | Type | Description |
|-------|------|-------------|
| `channel_id` | string | Channel identifier. Mattermost: the 26-char channel id. Slack: the channel id (`C…` / `G…`). |
| `max_messages` | integer (optional) | Messages to return, oldest first. Default 20, capped at 100. |

**Guardrail:** The channel must be the bot's own channel or a public channel on the same instance. On Slack the bot must also be a member. Returned content is untrusted.

## search_messages

Searches messages on the platform. **Mattermost only**; on Slack it returns an unsupported error.

| Input | Type | Description |
|-------|------|-------------|
| `query` | string | Search query. Mattermost supports phrase quoting and `from:user` filters. |
| `max_results` | integer (optional) | Results to return. Default 10, capped at 25. |

**Guardrail:** Results are filtered to in-scope channels only, meaning the bot's own channel plus public channels on the same instance. Returned content is untrusted.

## send_dm

Sends a direct message to a member of the bot's channel. Use it when the user asks to ping someone privately, for example a status update or a result they want delivered as a DM. The bot prepends an attribution line so the recipient can see the DM came from a session and who started it.

| Input | Type | Description |
|-------|------|-------------|
| `recipient` | string | Recipient identifier. Mattermost: a username (with or without a leading `@`). Slack: a user ID (`U0123ABC` or `<@U0123ABC>`). |
| `message` | string | Message body. The bot prepends an attribution prefix. |

**Guardrail:** The recipient must be a current member of the bot channel. The first DM to each recipient in a session triggers a permission prompt in the bot channel; a ✅ allow-all promotes that specific recipient to no-prompt for the rest of the session. A hard limit of 3 DMs per recipient per session applies.
