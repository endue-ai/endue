# Social Studio

Every social account the endue account connects, in one window: the accounts' own posts (Feed),
the replies and mentions to them (Replies), their numbers (Numbers) and what is being written for
them (Drafts). It reads the desk's index, so any connector that writes the social profile shows
here; `endue.social` (`plugins/social`) brings the endue account's networks and publishes for it.

- **Feed**: the accounts' posts, newest first, filtered by network, account and words.
- **Replies**: replies and mentions, the unseen first, each with the post it answers.
- **Numbers**: each account's series (followers, reach, engagement) and its best posts.
- **Drafts**: write once, pick the accounts, and see each account's preview with what does not
  fit it (too long, a picture it needs, a title, a signed-out account). Publish… shows what goes to
  each account and asks once; each account then answers on its own, with Try again where it failed.
  Drafts are files under `~/Documents/Social Studio/Drafts`. A picture loses where it was taken
  before it leaves unless `endue.social-studio.keep-location` is on.
- **Reply and Delete** on an open post, where its network takes them; Delete asks first.
- **Accounts**: grouped by network, each with its state; an expired one reads "Reconnect on
  endue.ai", and with the endue account's connectors off the sentence says where to turn them on.

`1` to `4` switch views, as `endue.social-studio.view` does. A network is a name and one of the
theme's chart colours, never a logo. Text from a network is set as text, never HTML; media show as
their kind and alt text, and a post opens on its network over `https` only.

## For agents

| Command | Answers |
| --- | --- |
| `endue.social-studio.accounts` | the accounts with state, handle, followers and capabilities |
| `endue.social-studio.posts` | own posts by `source`, `network`, `query`, `limit` |
| `endue.social-studio.replies` | replies and mentions, or those to `{ source, id }` |
| `endue.social-studio.numbers` | one account's series and best posts |
| `endue.social-studio.drafts` / `.current` | the drafts, or the one open in the window |
| `endue.social-studio.show` / `.draft` | opens a post; writes a draft and opens it |
| `endue.social-studio.publish` | publishes a draft to `accounts`, with its `text`, `title`, `media` |
| `endue.social-studio.reply` / `.delete` | replies to a post, or deletes one |

The readers are `readOnly`. `publish`, `reply` and `delete` are irreversible, so the desk asks the
person first, and `publish` carries the text and files it will send: a draft changed since is
refused. The item shape is `specs/connector/v0/README.md` §Social profile (ADR 0410).
