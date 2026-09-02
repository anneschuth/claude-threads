# Posts made through the app's own user token are the person's messages

Upstream discussion: anneschuth/claude-threads#TBD.

## What it does

A message posted with `chat.postMessage` and a **user token of this app**
(`xoxp-…`, obtained when a person authorises the app) shows up in Slack as
that person, and Slack delivers it with `user` = the person **and**
`bot_id` + `app_id` of the app. Today the Slack client drops every message
that carries a `bot_id`, so such a post never reaches Claude, silently.

With this change the client treats a message as bot-authored only when

- its `user` is the bot's own user (the daemon's replies), or
- it carries a `bot_id` and is **not** from this app with a human `user`.

So a post relayed through this app's own user token is handled exactly like
the person typing it: same session routing, same allow-list, same everything.
Other apps' bot posts, classic bot posts without a `user`, and the daemon's
own replies stay ignored, as before.

The rule is applied in the three places the filter lives: live events,
missed-message recovery after a reconnect, and thread history with
`excludeBotMessages`.

## Why

Any integration that speaks *for* a person — a voice front desk, a phone
bridge, an approval UI — posts on the person's behalf with the app's user
token, because that is the only way to keep attribution honest and the bot's
consent gate (channel membership, allow-lists) intact. Slack marks every
API-posted message with the app's `bot_id`; there is no way to post a
"pure" human message through the API. Without this exception the daemon
can never be driven by such an integration.

Origin: the VVS live voice desk (`voice/` on the `local/voice-desk` branch
of the kaza fork) relayed a spoken question into a task channel as the
speaker, and the daemon ACKed the event and dropped it at the `bot_id`
check with no log line. Seen 2026-09-02, message
`{user: U…, bot_id: B0BUDMNPD26, app_id: A0BSH7L7N9E, bot_profile: {…}}`.

## How

- The client learns its own app id from the Socket Mode `hello`
  (`connection_info.app_id`) and, belt and braces, from every `events_api`
  envelope (`payload.api_app_id`). Secondary clients on a shared socket get
  it handed over with each injected event. No new config, no new API call.
- One predicate, `isBotAuthored(message)`, replaces the three inline
  `user === botUserId || bot_id` checks.
- `app_id` is added to the `SlackEvent` and `SlackMessage` types; it was
  already on the wire.
- Until the app id is known (only possible before the first `hello`), the
  old rule applies: anything with a `bot_id` is ignored. Conservative, and
  the window is the connection handshake.

Why `app_id` and not `bot_id`: the `bot_id` on a user-token post is a
per-authorisation bot profile (`B0BUDMNPD26` above), different from the
bot token's own `bot_id` from `auth.test` (`B0BSH828Z6U`). `app_id` is the
one stable identity.

## Decisions

| Decision | Why |
|---|---|
| No config flag | with `app_id` checked, only this app's own user tokens qualify; nothing to opt out of |
| Learn the app id from the socket, not config | zero setup; every install already receives it |
| Old behaviour until the app id is known | never widen the filter on a guess |

## Lessons learned

- A dropped event at the "ignore ourselves" check leaves no trace in the
  log. Reproducing needed `conversations.history` on the exact `ts` to see
  the stored message's fields.
