---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# The desk uses the endue account's connectors with a key of its own

Builds on ADR 0130 (the account's settings through endue AI's platform API) and ADR 0239 (the
session in the OS keychain).

## Context and Problem Statement

A person connects Instagram, Threads, X and other networks once, on endue.ai. The desk should use
those connections, not ask for each network's sign-in again, and it should never hold the networks'
own tokens. endue AI's connector API answers for an account's connectors with a key, and the key
carries what it may do. How does the desk reach it, and what does it keep?

## Decision Drivers

* No network's token reaches the desk; the desk holds one key it can lose without losing the account
* Nothing is sent before the person turns it on
* The key may only read until the person first publishes or deletes
* A key that leaks gives the connectors it was allowed and nothing else of the account
* Turning it off, or signing out, leaves no key behind at endue

## Considered Options

* The session itself for connector calls
* A key of the desk's own, made with the session and kept in the OS keychain
* A key the person makes on endue.ai and pastes into Settings

## Decision Outcome

Chosen option: "a key of the desk's own", because it keeps the session for the account and the key
for the connectors, and the person only turns a switch.

* Settings, Connections opens with "endue account": "Use my endue connectors on this desk". Off,
  `account.connectors.status` sends nothing.
* `account.connectors.enable` makes a key with the session (`createApiKey`, scope
  `connectors:read`, named "endue Desk on <computer>", no expiry) and keeps it in the OS keychain
  under `endue-connectors` alone: no file, no log line, no bridge answer and no export holds it.
  Without a keychain the call is `unsupported` with a sentence.
* `allow: ["publish"]` or `["delete"]` widens it by replacing it: the new key (`connectors:send`,
  `connectors:delete`, with what the old one had) is kept first, and the old one is revoked only
  then. A revoke that does not go through is kept under `endue-connectors-revoke` and tried at the
  next start.
* Every connector call (`listConnectors`, `listConnectorTools`, `callConnectorTool`) carries the key
  and never the session, and is never retried with a refresh: a 401 means endue no longer accepts
  the key, and the desk forgets it once and says so. A 429 is `RateLimited { wait_secs }`; the
  `X-RateLimit-*` limits ride on every answer.
* `account.connectors.disable` and `account.signOut` forget the key and revoke it with the session
  while there is one.
* An expired connector is reconnected on endue.ai, never by the desk: the section says so and opens
  `<endue.ai>/resources/connectors` beside the platform the desk uses.

### Consequences

* Good, because one switch brings every network the account connected, and the networks' tokens
  stay at endue.
* Good, because the key may only read until the person publishes or deletes for the first time.
* Bad, because a desk without an OS keychain cannot use the account's connectors.
* Bad, because a turn-off while endue cannot be reached leaves the key at endue until the next
  start; the person sees it on endue.ai under the desk's name meanwhile.

### Confirmation

`crates/desk-platform/tests/connectors.rs` and `crates/desk-core/tests/account_connectors.rs` run
against the in-process fake platform and an in-memory keychain, and check that no file under the
desk's home and no bridge answer holds the key.
