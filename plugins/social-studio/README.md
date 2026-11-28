# Social Studio

Every social account the endue account connects, in one window: the accounts' own posts (Feed),
the replies and mentions to them (Replies), and their numbers (Numbers). It reads the desk's
index, so any connector that writes the social profile shows here; `endue.social`
(`plugins/social`) brings the endue account's networks.

- **Feed**: the accounts' posts, newest first, filtered by network, account and words.
- **Replies**: replies and mentions, the unseen first, each with the post it answers.
- **Numbers**: each account's series (followers, reach, engagement) and its best posts.
- **Accounts**: grouped by network, each with its state; an expired one reads "Reconnect on
  endue.ai", and with the endue account's connectors off the sentence says where to turn them on.

`1`, `2` and `3` switch views, as `endue.social-studio.view` does. A network is a name and one of
the theme's chart colours, never a logo. Text from a network is set as text, never HTML; media
show as their kind and alt text, and a post opens on its network over `https` only.

## For agents

| Command | Answers |
| --- | --- |
| `endue.social-studio.accounts` | the accounts with state, handle, followers and capabilities |
| `endue.social-studio.posts` | own posts by `source`, `network`, `query`, `limit` |
| `endue.social-studio.replies` | replies and mentions, or those to `{ source, id }` |
| `endue.social-studio.numbers` | one account's series and best posts |
| `endue.social-studio.show` | opens a post in the window |

All but `show` are `readOnly`. The item shape is `specs/connector/v0/README.md` §Social profile
(ADR 0410).
