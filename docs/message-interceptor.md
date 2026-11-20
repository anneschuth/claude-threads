# Message interceptor

Some messages need no model. A reply that picks option "1A, 2B" from a question the bot posted, a lookup that a script answers exactly, an acknowledgement: sending them to Claude still costs a full turn, and in a long thread that turn re-reads the whole conversation. `messageInterceptor` lets an operator command answer such a message instead.

```yaml
platforms:
  - id: mattermost-main
    messageInterceptor:
      command: ["/usr/local/bin/my-interceptor", "--flag"]   # argv, run without a shell
      timeoutMs: 10000                                        # optional, default 10000
```

## When it runs

Only for a message that is about to reach Claude, after every gate that would stop it: authorization, approvals, side conversations, quiet mode, `!commands`, pending worktree prompts. That is three places:

| `session` | The message would have... |
|---|---|
| `active` | been sent to the running session as a follow-up |
| `paused` | resumed the paused session |
| `none` | started a new session (a first message that set options or a worktree is not offered) |

A message with files is never offered: the interceptor sees text only. Nor is a first message that opens with a `!command`, or a message from an unapproved user that a participant then approves with *Allow once* or *Invite*: an approved message goes straight to Claude.

## Contract

stdin, one JSON object:

```json
{"version": 1, "platformId": "mattermost-main", "threadId": "abc", "postId": "def",
 "createAt": 1795150000000, "username": "alice", "message": "1A, 2B", "session": "active"}
```

`createAt` (ms since epoch) is present when the platform reports when the message was posted. A message the bot missed while disconnected can arrive late, after the question it answers was replaced; compare it with your own records before acting.

`message` is what Claude would have received: the bot mention removed, trimmed.

stdout, to answer it:

```json
{"handled": true, "reply": "Recorded 1A, 2B and requeued the job.", "reaction": "white_check_mark"}
```

`reply` is posted in the thread as the bot (split across several posts if it exceeds the platform's post limit); `reaction` is added to the message. Both are optional. With `handled: true`, Claude does not run for this message. In an `active` session, the message and the reply reach Claude with its next turn as side-conversation context, so it is never surprised by a decision made around it. That context lives in memory, as for any side conversation: if the session pauses before its next turn, it is not carried into the resumed session, and a turn sent with thread context (the first message after `!cd`) does not include it.

A message the interceptor lets through is routed again from the start, since the session may have paused or started while the command ran. If it was on its way to a session that was stopped meanwhile, it is dropped with that session rather than starting a new one. If the platform is disabled, or the bot starts shutting down, while the command runs, the message is dropped and no reply is posted.

Everything else means "let it through": `handled` not exactly `true`, invalid JSON, more than 64 KB of output, a non-zero exit, a spawn error, or no answer within `timeoutMs` (the command is then killed). On POSIX the command runs in its own process group, and whatever it leaves running in that group is killed when it exits. A broken interceptor therefore costs only what not having one costs, with one exception: nothing is rolled back. A command that acts and then fails to answer in time (or exits non-zero, or prints invalid JSON) has acted, and Claude still receives the message. Make any change the command makes idempotent, keyed by `platformId` and `postId`, or keep it read-only until it is sure to answer. stderr is ignored.

At most 8 interceptor commands run at once across the bot; a message arriving while 8 are running passes through without being offered.

A reply or reaction that cannot be delivered is logged as an error; the message is still not sent to Claude, since the command already acted.

Each handled message is recorded in the audit log (when enabled) as a `command` entry with tool `message-interceptor`.

## Notes

- The handler waits for the interceptor before routing the message, so keep it fast. A second message in the same thread can overtake one that is still being intercepted.
- Derived DM instances do not inherit the setting.
- Disabling a platform or shutting down drops interceptor results that have not been delivered yet. A reply or reaction the platform client is already retrying (for example during a Slack rate-limit backoff) is not cancelled and may still land.
- On POSIX each command runs in its own process group, killed on timeout and on exit. A `SIGTERM` that arrives during startup, before the bot installs its signal handlers, skips that cleanup, so a command started in that window runs to its own end.
