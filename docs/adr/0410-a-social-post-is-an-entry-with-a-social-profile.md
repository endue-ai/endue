---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# A social post is an entry with a social profile

Builds on ADR 0032 (actions are commands), ADR 0078 (irreversible commands wait for approval) and
ADR 0409 (a connector plugin can be the endue account's connectors, as data).

## Context and Problem Statement

The endue account can connect several social networks, and endue AI serves them all with the same
three tools (`<type>__social_read`, `__social_publish`, `__social_delete`). Item kinds are a closed
list (`specs/item/v0`): there is no `post`. Mail reads every `message` that names no channel, and
Chat reads those that do. Where does a post go, so that a studio, a view or an agent reads every
network the same way, and Mail and Chat stay as they are?

## Decision Drivers

* One set of fields with one meaning on every network; a number a network does not give is absent
* No schema change for one more domain, and no table of networks in a plugin
* What the account cannot do comes from the account, not from Desk

## Considered Options

* A new item kind `post` in `specs/item/v0`
* `message` items with a profile in `raw`, as Chat does
* `entry` items with a social profile in `raw`

## Decision Outcome

Chosen option: "`entry` items with a social profile in `raw`", because an entry already has a
feed, a URL and a publication time, Mail and Chat never read entries, and the profile is data the
spec README can hold without a schema change.

* A post, a reply and a mention are `entry` items; `raw.network` marks them, and the profile's keys
  (`specs/connector/v0/README.md` §Social profile) are the same on every network. A direct message
  stays a `message`.
* The account is a `record` whose fields are the tool's profile, `capabilities` included; its
  numbers are `metric` items.
* Publishing, replying and deleting are `<connector>.post.publish`, `.post.reply` and `.post.delete`,
  `irreversible` and `agent: true`.
* `endue.social` (`plugins/social`) is the data-only connector that brings them from the account.

### Consequences

* Good, because a studio, Today or an agent reads every network with one query
  (`raw.network exists`) and one set of keys.
* Good, because a new network on endue AI needs no change in Desk.
* Bad, because the profile lives in `raw`, which the item schema does not check: the item vectors
  and the plugin's tests keep it honest.

### Confirmation

`crates/desk-core/tests/endue_social.rs` loads `plugins/social` against two fake networks and
compares what it writes with `specs/item/v0/vectors/valid/*social*.json`; `crates/desk-cli/tests/validate.rs`
validates the plugin; Mail's and Chat's tests show their lists unchanged with social entries in the
index.
