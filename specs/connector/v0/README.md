# endue connector v0

A connector brings an app's data into endue as items (`specs/item/v0`) and its actions as commands; it
has no screen of its own (ADR 0032). One contract, four bindings: `wasm`, a component the plugin's
`entry` names (local and light, no VM), `mcp`, an MCP server inside the VM (ADR 0002), `http`,
requests and a mapping the core runs from the manifest, with no code and no `entry` (ADR 0106), and
`endue`, the endue account's connectors, whose tools the core calls with the desk's own key (no code,
no `entry`; ADR 0409). A plugin of
kind `connector` declares it under `connector` in `plugin.json`: `ConnectorManifest` in
`connector.schema.json`. v0 may break on any minor release (ADR 0004).

| Field | Meaning |
| --- | --- |
| `binding` | `wasm`, `mcp`, `http` or `endue` (then `http` or `endue` says what the core runs) |
| `auth` | `kind` `none`, `token` (pasted; `title` says what), `oauth` (`authorizationUrl`, `tokenUrl`, `scopes`; declared only: no v0 method starts a flow) or `endue` (the endue account the desk signed in to; binding `endue` only) |
| `resources` | One entry per item kind it brings in: `kind`, `actions` (command ids), `live` (it also answers queries beyond the index) |
| `sync` | `mode` `pull`, `push` or `both`; `intervalSeconds` between pulls, 60 to 86400, 900 when absent |
| `instanceSettings` | What the person fills in per instance, by name: `kind` (`string`, `integer`, `boolean`), `title`, `description`, `default`, `required`, `secret` |

- Actions are commands: every id in `resources[].actions` is one the plugin declares in
  `contributes.commands`, and views, the palette, Eris and agents run it with `cmd.invoke`. There is no
  `data:write`. `desk_bridge::manifest_problems` checks the rule; the contract tests judge vectors with it.
- Secrets stay with the core and never come back out (ADR 0036): a `secret` setting is a string that is
  never listed back and never handed to the connector's code, and so are tokens.

## HTTP binding

`http` (`HttpBinding`) is a connector as data. The core runs it; nothing of the plugin's runs.

| Field | Meaning |
| --- | --- |
| `baseUrl` | https, or http on 127.0.0.1 / localhost. Every request needs the plugin's `net:fetch` grant for its host |
| `headers` | Sent with every request; never `Authorization`, `Cookie` or `Host` |
| `auth` | `setting`, a secret instance setting the core reads; sent as `header` (`Authorization`) with `prefix` (`Bearer `) |
| `requests` | GET `path` with `query`; the records at the pointer `items`; `pagination` `link` (RFC 8288 `rel="next"`) or `body` (a URL at `pointer`), on the base URL's origin only, `maxPages` (10) at most; the `map` that makes them items |
| `maps` | By name: `kind` and `fields`, each item field from a JSON pointer into the record (`""` is all of it), `{ pointer, after?, before?, values?, default? }`, `{ const }`, `{ object: { name: value } }` (an object of values; one that reads nothing is left out) `{ instance: id \| title \| type \| syncedAt }` (`type` is the endue account connector's type, missing for the other bindings; `syncedAt` when this sync began) or `{ first: [value, ...] }` (the first that reads something other than null or `""`) |

- Each sync reads every page of every request again, writes what is new or changed and removes what
  left; the same id from two requests is one item. A record whose item does not fit `specs/item/v0` is
  skipped. A 401 or 403 is `error` with `reauth`; a 429, or a 403 with `x-ratelimit-remaining: 0`, waits
  for the next sync. Messages name the status, never the token.
- `desk_bridge::manifest_problems` checks the names: `auth.setting` is a declared secret setting,
  `auth.kind` is `token`, each request's `map` is in `maps`, each map's `kind` is in `resources`, and
  each map's `fields` give `id` and `title`.

## endue binding

`endue` (`EndueBinding`) is a connector as data over the endue account's connectors (ADR 0409). The
core runs it with the desk's own key (ADR 0407); nothing of the plugin's runs, and it needs no
`net:fetch`.

| Field | Meaning |
| --- | --- |
| `tools` | The tool endings an account connector must offer, all of them, to be an instance: `social_read` matches `<type>__social_read` |
| `requests` | The `tool` a sync calls with `arguments` (`{ const }`, `{ page: true }`, the cursor the previous page's `next` pointed to, or `{ since: true }`, the last good sync's time); the records at the pointer `items` in the answer's `data` (an array, or one object that is one record); `next`, the pointer to the next page's cursor; `maxPages` (10); the `map`; `optional` (a refusal `unsupported` skips it) |
| `maps` | The http binding's maps, by name |
| `actions` | By command id: the `tool` it calls, its `risk` (`read`, `write`, `send`, `destructive`) and its `arguments` (`{ const }`, `{ arg }`, the command's argument of that name, or `{ file }`) |
| `budget` | Tool calls one sync makes at most: 1 to 200, 30 when absent |

- Instances are the account's connectors that offer every tool, kept as the account changes (at
  start, every sync interval, on `connector.sync`, when the key is turned on or off); one that leaves
  takes its instance and items. The instance id is the account connector's id in lowercase, its title
  the connector's display name; `settings` say which connector it is (`connector`) and how many records
  the last sync skipped (`skipped`). `connector.connect` and `connector.disconnect` are `unsupported`.
- A tool answer with `ok: false` is `error` in the tool's own words (with `reauth` when its
  `error.reason` is `reauth`), and `truncated: true` too; neither writes anything. A refusal `quota`
  stops the sync like the limit, the next one after `retry_after`. A sync that spends its budget or reaches the limit writes what it read and removes
  nothing; a request with `since` only adds and changes. A 429 or `X-RateLimit-Remaining: 0` holds the
  next call until the wait. An expired account connector is `error` with `reauth`; with the desk's key
  off, instances are `paused` with a sentence that says where to turn it on.
- The core registers the commands of `actions` while the plugin is on and answers them: the command's
  `instance` argument names the instance. Each invocation carries one `Idempotency-Key`, the same on the
  one retry after a lost answer. A tool whose risk is higher than its action's is refused uncalled. A
  `{ file }` argument is refused until endue AI's connector API takes an upload.
- `desk_bridge::manifest_problems` checks the names: each request's and action's `tool` is in `tools`,
  each request's `map` in `maps`, each map's `kind` in `resources` with `id` and `title`, each action a
  command in `contributes.commands`, and each action on a `send` or `destructive` tool `irreversible`.

Host-facing: `ConnectorInstance` (an id unique within its connector, which items carry in `source`; its
settings but the secret ones; status), `ConnectorStatus` (`connected`, `syncing`, `stale`, `error` with
`message` and `reauth`, or `paused`; `lastSyncAt`) and `ConnectorSyncResult` (`changes`, the next
`cursor`, `done`).

## Social profile

A post, a reply and a mention from a social network are `entry` items with this profile in `raw`;
a direct message is a `message`, never a social entry. `endue.social` (`plugins/social`) brings them
from the endue account's social connectors. An entry from one network and one from another differ
only in values.

| `raw` field | Meaning |
| --- | --- |
| `network` | The network's id (`instagram`, `reddit`, ...). Its presence marks a social entry |
| `account` | The instance it came from |
| `destination` | Where in the account (a page, a community); absent when the account is the only place |
| `postKind` | `post`, `reply` or `mention` |
| `replyTo` | The id of the entry this one answers |
| `handle`, `authorName`, `avatar` | Who wrote it (`handle` without `@` or `u/`) |
| `self` | Written by the account itself |
| `media` | `[{ kind, url?, preview_url?, alt? }]`, `kind` one of `image`, `video`, `link`, `other` |
| `truncated` | The body is cut; the network has the whole text |
| `likes`, `replies`, `reposts`, `views` | Counts, each absent when the network does not say, never 0 |

The envelope: `title` (the post's title, else the text's first line), `body` (the text), `url` (the
post on its network), `feed` (the account's name), `publishedAt` and `updatedAt`.

The account is a `record` (`schema` `https://endue.ai/schemas/desk/social-account.json`) whose
`fields` are its profile: `network`, `account { id, handle, name?, avatar_url?, url?, followers?,
following?, posts? }`, `destinations? [{ id, name, kind, url? }]`, `capabilities` and `limits?`
(sentences). What it cannot do is read from `capabilities`: `text { max, required }`, `title { max,
required } | false`, `media { image, video, required }` (each `{ max_count, max_bytes, types } |
false`), `link`, `reply`, `delete_post`, `delete_comment`, `insights`, `inbox`, `destinations`,
`schedule`. Its numbers are `metric` items, `series` `followers`, `reach`, `engagement`, with `unit`
`count`, `ratio` or `seconds`. Both carry `raw.network` and `raw.account`.

| Command | Args | Result |
| --- | --- | --- |
| `<connector>.post.publish` | `{ instance, destination?, text?, title?, media?: [{ url, alt? }], link?, replyTo? }` | `{ id, url?, status }`, `status` one of `published`, `processing`, `scheduled` |
| `<connector>.post.reply` | `{ instance, id, text }` | `{ id, url? }` |
| `<connector>.post.delete` | `{ instance, id }` | none |

All three are `irreversible` and `agent: true`. A network that cannot do one refuses it with the
reason `unsupported`, in its own words.

## MCP profile

Any MCP server is a weak connector (tools only, for the brain); one that follows this profile is strong.

- Items are resources of MIME type `application/vnd.endue.item+json`, each one v0 `Item`. Their URIs are
  the server's own; the host sets `source`, whatever the server sent.
- `resources/read` of `desk://sync?cursor=<cursor>` (no cursor: from the start) returns one
  `ConnectorSyncResult` as `application/vnd.endue.sync+json`.
- With `sync.mode` `push` or `both`, a `resources/subscribe` to `desk://sync` makes the server send
  `notifications/resources/updated` when something changed; the host reads again.
- The action `<plugin id>.<name>` is the server's tool `<name>`, called with the command's args.

`vectors/` holds valid and invalid connector blocks, instances, statuses and sync results.
