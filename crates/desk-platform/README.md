# desk-platform

The client of endue AI's platform API subset that endue calls (`specs/platform/v0`, ADR 0122): the
person's agents, what Studio shows of one, the catalog, conversations and an agent's side, the
spaces (ADR 0129), account settings (ADR 0130) and the account's connectors through the desk's own
key (ADR 0407). desk-core serves it as `studio.*`, `account.settings.*` and `account.connectors.*`.

## Public API

- `Platform::new(base_url, tokens)`, `Platform::from_env(tokens)` (`DESK_ENDUE_PLATFORM_URL`
  overrides `https://platform.endue.ai`); `with_timeout` changes the 15 s deadline. `Tokens` gives
  the bearer token and the one retry after a 401.
- Agents: `list_agents`, `list_agents_page`, `get_agent`, `create_agent`, `update_agent`,
  `set_status`, `delete_agent`; faces (ADR 0232): `face_of`, `picture` (https, at most 512 KB).
- Facets: `identity`, `settings`, `update_settings`, `prompt`, `save_prompt`, `restore_prompt`,
  `prompt_revisions`, `skills`, `connectors`, `traits`, and Studio's board (`wire_board`).
- Catalog and conversations: `catalog`, `recommend`, `use_catalog`, `conversations`; a thread's
  `messages`, `mark_read`, `new_agent_conversation`, `stream_turn`, `attach`, `cancel_run`.
- An agent's side (`wire_side`): `topics`, `new_topic_conversation`, `ConversationQuery::topic_id`,
  `routines` (the schedule worded plainly); no prompt, webhook or run is read.
- Spaces, read only: `spaces`, `space`, `space_overview`, `space_rooms`. Account: `me`,
  `update_me`, `preferences`, `notifications` and their updates (`wire_account`).
- The desk's key (`wire_connectors`): `create_key`, `revoke_key`; `with_key(secret)` → `Connectors`
  (`list`, `tools`, `call`, each with its `RateLimit`), never the session. No `Debug` prints a secret.
- `PlatformError { kind, status, code, message }`; `ErrorKind`: `SignedOut`, `Offline`, `Forbidden`,
  `NotFound`, `Invalid`, `Conflict`, `RateLimited { wait_secs }`, `Failed`.
- `fake::FakePlatform` (feature `fake`, tests only): the platform on 127.0.0.1, in memory.

Requests go over desk-sys's fetch, a run's stream over `stream.rs`: rustls, the system proxy, and
an allowlist of the base's host alone. Bodies are read tolerantly; no Origin header is sent.

## Test

```bash
cargo test -p desk-platform
```

`tests/*.rs` run the client against the fake; `tests/contract.rs` judges the contract's vectors and
checks the bodies the client sends against it. No test leaves this machine.
