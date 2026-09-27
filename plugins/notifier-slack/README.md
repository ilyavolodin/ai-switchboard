# @ai-switchboard/notifier-slack

Notifier type `slack`: posts run outcomes (`ok`, `error`, `held`, `throttled`) and system alerts
to a Slack channel as a Block Kit message.

**Network:** `hooks.slack.com`, `slack.com`.

## Settings

| Field        | Group            | Secret | Description                                                                         |
| ------------ | ---------------- | ------ | ----------------------------------------------------------------------------------- |
| `mode`       | Delivery         |        | `webhook` (default) or `bot`                                                        |
| `webhookUrl` | Incoming webhook | yes    | `https://hooks.slack.com/services/…`, for `webhook` mode. The URL is the credential |
| `botToken`   | Bot              | yes    | `xoxb-…`, for `bot` mode                                                            |
| `channel`    | Bot              |        | Channel id (`C0123…`) or `#name`, for `bot` mode. The bot must be a member          |

## Message

- A **header** with the title.
- A context line with the severity as a word (`INFO`, `WARNING`, `ERROR`) and the trigger
  (`on`). No emoji.
- A section with the text.
- The fields as a two-column section (split every ten fields, Slack's limit).
- An **Open** button linking to `url` when there is one (red for errors).
- A plain fallback `text` (`[ERROR] <title>: <text>`) for notifications and old clients.

`&`, `<` and `>` are escaped in the text and fields, so event content cannot produce
`@channel` mentions or disguised links. Put links in `url`.

## Errors

`send` throws when Slack refuses: a non-2xx from the webhook (Slack's reason, such as
`no_service`, is in the message), a non-2xx from the Web API (a 429 includes Retry-After), or
`ok: false` from `chat.postMessage` (e.g. `not_in_channel`, `invalid_auth`).

## Health

- `webhook`: `unknown`; an incoming webhook cannot be checked without posting.
- `bot`: `auth.test`; `healthy` when the token is valid.

## Credentials

- Incoming webhook: create a Slack app, enable **Incoming Webhooks**, add one to the channel.
- Bot: a Slack app bot token with the **`chat:write`** scope, invited to the channel
  (`chat:write.public` to post to public channels without joining).
