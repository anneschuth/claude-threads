# Turn marker: the daemon says when a turn is over

Upstream discussion: anneschuth/claude-threads#528 (the maintainer proposed
this shape on 2026-09-03).

## What it does

A per-platform setting:

```yaml
platforms:
  - id: slack-main
    type: slack
    turnMarker: metadata        # reaction | metadata | off (default)
    turnMarkerEmoji: checkered_flag   # reaction only; default checkered_flag
```

When Claude's turn ends (the CLI's `result` event) the daemon marks **the
turn's last reply post**:

| `turnMarker` | What happens | Who can see it |
|---|---|---|
| `metadata` | the final edit of that post carries Slack message metadata: `event_type: claude_threads_turn_complete`, `event_payload: { session, turn, ok }` | integrations reading history with `include_all_metadata`; invisible in the UI. Slack only |
| `reaction` | the bot adds `turnMarkerEmoji` to that post | everyone, and any integration reading reactions. Slack and Mattermost |
| `off` | nothing; today's behaviour | |

`ok` is false when the result event reports an error. `turn` counts the
session's turns from 1. A turn that produced no reply post (only a task
list, a question, an approval) has nothing to mark and marks nothing.

Untouched: prompts, questions and approvals (a blocked turn has no `result`
and is not marked; a `turn_waiting` marker for those is a possible follow-up,
asked in #528), the streaming itself, every other post.

## Why

Any integration that reads the channel has to know when the answer is
complete. The daemon streams by editing one post, so "the text stopped
changing" is the only signal today, and every integration reinvents the same
guess (voice-desk: identical on three polls, ~8–12 s late, wrong when a tool
pauses the turn). The daemon knows the truth to the millisecond.

## How

- **Config** (`src/config/types.ts`): `turnMarker?: 'reaction' | 'metadata' | 'off'`,
  `turnMarkerEmoji?: string` on `PlatformInstanceConfig`; resolved with the
  other per-platform dials into `PlatformOverhead.turnMarker: { mode, emoji }`
  (`resolveTurnMarker(mode, emoji, platformType, path)`; `metadata` on a
  non-Slack platform is a startup config error with the field path; an emoji
  with `metadata`/`off` is one too). Wired like `sessionHeader` through
  `index.ts` → `SessionManager` → `MessageManager` options.
- **The result event carries its outcome**: `transformResult` sets
  `resultOk` on the `flush` op it emits (`FlushOp.resultOk?: boolean`, only
  with `reason: 'result'`). No new op.
- **Metadata rides on the final flush** (`ContentExecutor`): the platform's
  `updatePost` / `createPost` gain an optional `{ metadata }`; when the
  executor flushes with `reason: 'result'` and a metadata marker is set, the
  write that lands the last text carries it. If nothing is pending at the
  result (the text was already flushed), the executor re-sends the current
  post text with the metadata — one extra edit, only in that case. Slack's
  `chat.update` requires text, which is why the marker cannot be a
  text-less call. Mattermost ignores metadata (its `updatePost` signature
  accepts and drops the option; `metadata` is rejected at config time there).
- **Reaction after the final flush** (`MessageManager`, in the `result`
  flush branch): `platform.addReaction(lastPostId, emoji)`. An
  `already_reacted` is not an error; any other failure is logged and does
  not touch the reply.
- **The turn counter** lives in the `MessageManager` (`turn` increments on
  each `result`), reset with the manager.

## Reading it (what voice-desk does, for the record)

`conversations.history` with `include_all_metadata=true`; a bot post whose
`metadata.event_type` is `claude_threads_turn_complete` is delivered at once.
In reaction mode: a bot post carrying the marker emoji from the bot user.
Without either, the old quiet rule. No configuration on the reader's side.

## Tests (first)

- config: defaults, `metadata` on Mattermost rejected, emoji with `off`
  rejected, custom emoji accepted.
- transformer: the result flush op carries `resultOk` true/false.
- content executor: final flush with a metadata marker passes it to the
  platform write; nothing pending at result → one re-send with metadata;
  no marker → no metadata anywhere; the marker never lands on a
  non-final flush.
- message manager: `reaction` adds the emoji to the last post after the
  result flush, once; `off` does nothing; a turn with no post marks nothing;
  the turn counter increments; `ok` false on an error result.
- slack client: `chat.update` / `chat.postMessage` body carries `metadata`
  when given, not otherwise.

## Decisions

| Decision | Why |
|---|---|
| Metadata on the final flush, not a separate edit | `chat.update` needs text; the final flush already sends it, so the marker costs nothing in the common case |
| `reaction` default emoji 🏁 `checkered_flag` | rare in real conversations, reads as "finished" without words |
| `metadata` refused on Mattermost at config time | rather than silently marking nothing |
| Payload is small and flat: session, turn, ok | Slack caps metadata size; readers need identity and outcome, not the answer |
| `ok` from the result event, not from the text | the daemon has the fact; parsing "error" from the reply would be the guess this replaces |

## Lessons learned

(none yet)
