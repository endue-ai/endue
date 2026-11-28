# endue AI platform API v0: the desk's subset

`openapi.yaml` (OpenAPI 3.1) writes down the part of endue AI's own platform API (`/api/v1`, what
endue.ai's web calls) that endue uses to create and manage the person's endue AI agents (ADR 0122)
and to read the spaces they can open (ADR 0129). endue AI serves it; `crates/desk-platform` is endue's
client, and the core serves it on the bridge as `studio.*` (`specs/bridge/v0/studio.schema.json`,
`studio-spaces.schema.json`) under `studio:manage`. The person's own account settings (ADR 0130) are
served as `account.settings.*` (`specs/bridge/v0/account.schema.json`) under `account:manage`.

| Area | Operations |
| --- | --- |
| Agents | `listAgents`, `createAgent`, `getAgent` (with the addresses of its face, ADR 0232), `updateAgent`, `deleteAgent` (soft), `setAgentStatus` |
| Studio facets | `getAgentIdentity`, `getAgentSettings`, `updateAgentSettings`, `getAgentPrompt`, `saveAgentPrompt`, `listPromptRevisions`, `restorePromptRevision`, `listAgentSkills`, `listAgentConnectors`, `listAgentTraits` |
| Studio's board (ADR 0232) | `listChannelPairings`, `listAgentOsDevices`, `listAgentWorkspaces`, `getAgentTheme`, `listAgentMemories` (counted), `listApiKeys` (the agent's own), `listArtifacts` (counted) |
| Catalog | `listCatalogAgents`, `recommendCatalogAgents`, `useCatalogAgent` |
| Conversations | `listConversations` (the Home board, or a topic's threads), `createAgentConversation`, `runAgentConversation`, `getConversation`, `listConversationMessages`, `markConversationRead`, `cancelConversationRun`, `attachConversationRun` |
| An agent's side | `listAgentTopics`, `listRoutines` (of one agent) |
| Spaces | `listSpaces` (with summaries), `getSpace`, `getSpaceOverview`, `listSpaceRooms`, `ensureSpaceConversation` |
| Account | `getMe`, `updateMe`, `getMyPreferences`, `updateMyPreferences` (language, time zone), `getNotificationPreferences`, `updateNotificationPreferences` |
| The desk's own key | `createApiKey`, `revokeApiKey` (with the session) |
| Connectors | `listConnectors`, `listConnectorTools`, `callConnectorTool` (with the desk's own key, never the session) |

## Base, token and envelopes

- The base is `https://platform.endue.ai`; `https://platform.dev.endue.ai` is endue AI's development
  platform, and `DESK_ENDUE_PLATFORM_URL` overrides both.
- Every call carries `Authorization: Bearer <endue ID access token>` from the core's account. endue
  uses its own HTTP client. It waits 15 s for most calls and 30 s for `useCatalogAgent`; a run's
  stream is read as it comes, given up after 90 s without a byte, and cut past 2 MiB. A 401 can renew the token once and retry the same body.
- agent-service answers the bare body for agents, identity, prompt, skills, connectors and traits, and
  `{ data, meta }` for settings. The catalog answers `{ data, meta }`; ai-agent-service (`/api/v1/ai`)
  answers `{ success: true, data }`. user-service answers the bare body; notification-service answers
  `{ data, meta }`. Errors are `{ error: { code, message, details?, suggest? }, meta }`.
  The space list and one space answer the bare body; a space's overview and rooms `{ data, meta }`.
  Channel pairings, devices and workspaces answer the bare body; an agent's theme the bare body or
  `{ data }`; artifact-service `{ data, meta: { pagination } }`, whose total endue counts. Workspaces
  answer 404 `FEATURE_DISABLED` while endue AI has them turned off, which endue reads as none.
- Bodies are snake_case. Readers ignore fields this document does not name and read `null` as absent,
  so endue AI can add fields without breaking endue.
- Only what a card shows is named. People's ids, room members, a viewer's capabilities, attention
  items' reasons and anything about billing stay unnamed and unread, and nothing here names a host or
  a route other than the public gateway's.

## Errors on the bridge

| Platform | `studio.*` error code |
| --- | --- |
| no token, or 401 after one refresh | `signed_out` |
| unreachable, or silent past the timeout | `offline` |
| 403 | `forbidden` |
| 404, 410, and 409 on delete (already deleted) | `not_found` |
| 400, 422 | `invalid_params` |
| 409 on set status (it already has it) | none: the call succeeds |
| anything else | `io_error` |

## Questions and threads

One agent question opens a conversation with the agent and requests the `ask` approval level.
A space question uses the server's existing Front Desk conversation and its bound agent. The
Desk checks the binding before sending. Each text run carries one `client_message_id` across an
auth retry. The completed `done` event supplies the final assistant message. Partial events,
interactive stops and transport failures produce a status and a conversation reference.

An agent's window is that agent's conversation. A new one sends the agent alone (no title of the
desk's own). The run's events `run_created`, `delta`, `step`, `run_presentation`, `interaction`,
`done` and `error` are read as they arrive (`attachConversationRun` joins a run in flight); any
other event is skipped. Of a message page the desk keeps the person's and the agent's words, their
times and runs, and each turn's work: its phase, times, counts, and per tool its name, connector,
calls and failures. Tool rows, an assistant row's tool calls and system notes fold into that work;
no tool argument, tool result, reasoning, memory, file or person's id is read. Where the thread
draws its new-messages line is the conversation's `last_read_at`, read before `markConversationRead`.
The desk's field names for these were taken from endue.ai's own clients.

## An agent's side

The side of an agent's window lists its topics and routines. A topic is read as its name, its thread
count (its conversations other than the main one), its last activity and its main conversation;
`listConversations` with `topic_id` reads its threads, and a new thread is `createAgentConversation`
with the agent and the topic. A routine is read as its name, its status (on while `active`), its
trigger and schedule (five cron fields or a one-time time, and a time zone, which endue words
itself), when it last ran and how many runs failed in a row (the last run failed when that is above
0). A topic's instructions, goal and files, and a routine's prompt, webhook address and secret,
config, conversation and runs are never read. The field names were taken from endue.ai's own clients
(its Android app's `TopicsApi` and `RoutinesApi`) and ai-agent-service's mappers.

## Vectors

`vectors/valid` and `vectors/invalid` hold `{ target, description, instance }` files whose target is a
component schema. `node scripts/spec-lint.mjs` and `crates/desk-platform/tests/contract.rs` judge each
as its folder says; the Rust test also reads every valid one into the client's types.
