# plugins/social

`endue.social`, the social networks connected to your endue account: a `connector` plugin with no
code. Its `endue` block (`specs/connector/v0`, ADR 0409) is what the core runs every 15 minutes, with
the desk's own key (ADR 0407), over every account connector that offers the three social tools
(`<type>__social_read`, `__social_publish`, `__social_delete`). Each such connector is one instance;
connect, reconnect and remove them on endue.ai.

| Request (`social_read`) | Brings in |
| --- | --- |
| `profile` | the account, as one `record`: its `capabilities` (text length, media kinds and count, reply, delete, numbers), destinations and limits |
| `posts` | the account's posts and replies since the last sync, as `entry` items |
| `inbox` | replies and mentions to the account since the last sync, as `entry` items (skipped where the network has none) |
| `insights` | `followers`, `reach` and `engagement` by day, as `metric` items (skipped where the network has none) |

An entry carries the social profile in `raw` (`network`, `account`, `destination`, `postKind`,
`replyTo`, `handle`, `authorName`, `avatar`, `self`, `media`, `truncated`, `likes`, `replies`,
`reposts`, `views`), the same keys on every network; a count the network does not give is absent.
`specs/connector/v0/README.md` §Social profile is the contract.

| Command | Tool, `operation` |
| --- | --- |
| `endue.social.post.publish` `{ instance, destination?, text?, title?, media?, link?, replyTo? }` | `social_publish`, `publish` |
| `endue.social.post.reply` `{ instance, id, text }` | `social_publish`, `reply` |
| `endue.social.post.delete` `{ instance, id }` | `social_delete`, `delete_post` |

All three are `irreversible`, so an agent's call waits for the person (ADR 0078), and each carries
one `Idempotency-Key`. Media goes by public https URL; files cannot be sent yet.

It asks for no permission: the core makes every call. With the account's connectors turned off in
Settings, Connections, the instances are `paused` and say so.
