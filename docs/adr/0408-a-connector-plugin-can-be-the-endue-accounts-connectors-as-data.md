---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# A connector plugin can be the endue account's connectors, as data

Builds on ADR 0032 (actions are commands), ADR 0078 (irreversible commands wait for approval),
ADR 0106 (the http binding) and ADR 0407 (the desk's own key for the account's connectors).

## Context and Problem Statement

The desk can call the endue account's connectors with a key of its own (ADR 0407), but nothing
turns what their tools answer into items, and nothing lets a plugin act through them. Chat, Mail,
Calendar and a social studio will each want the account's connectors of their kind. The http
binding is data the core runs, but it fetches one base URL with a pasted token and has no actions;
a Wasm connector can fetch but never receives a secret; an MCP server needs the VM. How does a
plugin say "my data is the account's", without code and without a connect step?

## Decision Drivers

* Nothing of the plugin runs, and it needs no `net:fetch`: the core makes every call with its key
* The core holds no network's name, field or limit
* Half an answer is never mapped, and a retried change does not act twice
* What an agent does through it waits for the person as any irreversible command does

## Considered Options

* A Wasm connector per kind that receives the key
* The http binding with endue AI's connector API as its base URL
* A fourth binding, `endue`, that the core runs over the account's connectors

## Decision Outcome

Chosen option: "a fourth binding", because the key stays in the core, the plugin stays data, and
the binding can list the account's connectors, which an http block cannot.

* `binding: endue` with `auth.kind: endue` and an `endue` block (`specs/connector/v0`
  `EndueBinding`): `tools` (the tool endings an account connector must offer), `requests` (the read
  calls of a sync), `maps` (the http binding's), `actions` (by command id) and `budget`. Such a
  plugin has no entry.
* **Instances are the account's connectors.** At start, every sync interval, on `connector.sync`
  and when the key is turned on or off, the core lists the account's connectors and keeps one
  instance per connector that offers every tool, its id the connector's in lowercase and its title
  the display name. A tool is found by its ending: a connector of type `t` offers `t__<ending>`, and
  the core never reads `t`. A connector that leaves takes its instance and items with it.
  `connector.connect` and `connector.disconnect` are `unsupported`: that happens on endue.ai.
* **A sync** calls each request's tool with constants, `page` (the cursor the previous page's
  `next` pointed to) and `since` (the last good sync's time), maps the records at `items` and
  writes what changed. `ok: false` is `error` with the tool's own words; `truncated: true` fails it
  too, writing nothing. A record that is no item is skipped and counted (`settings.skipped`). A
  sync that spends its budget, or reaches `X-RateLimit-Remaining: 0`, writes what it read and
  removes nothing, and a 429 or the limit moves the next sync past the wait. A request with
  `since` only adds and changes.
* **Statuses.** An expired account connector is `error` with `reauth` ("Reconnect … on endue.ai.").
  With the key off, the instances are `paused` with a sentence that says where to turn it on, and
  no call is made.
* **Actions are commands** the core registers for the plugin while it is on and answers itself:
  the command's `instance` argument picks the connector, its other arguments fill the tool's
  (`const`, `arg`). An action on a `send` or `destructive` tool must be `irreversible`
  (`desk plugin validate`), and a tool whose catalog risk is higher than the action declares is
  refused before it is called. Each invocation makes one `Idempotency-Key`, the same on the one
  retry after a lost answer (no answer, or a 5xx). A `file` argument is refused with a sentence
  until endue AI's connector API takes an upload.
* Removing the plugin removes its instances, items, store and commands.

### Consequences

* Good, because a plugin of a few dozen lines of JSON brings every network of one kind the account
  connected, and acts through them.
* Good, because the networks' fields live in the plugin's maps, not in the core.
* Bad, because a sync is bounded by the account's API limits: a large account fills over several
  syncs.
* Bad, because media cannot be attached yet.

### Confirmation

`crates/desk-core/tests/endue_binding.rs` runs a fixture plugin with made-up tools against the
in-process fake platform: instances from the account, pages, since, skipped records, truncated and
refused answers, budget and limits, one idempotency key per invocation, the tool's words as the
command's error, expired, the key off, and removal. `crates/desk-bridge/src/names.rs` checks the
names an endue block uses; `crates/desk-cli` runs `desk plugin validate` on it.
