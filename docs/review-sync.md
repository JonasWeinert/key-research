# Review events and a proposal for sync and web sharing

Systematic reviews (`docs/review-design.md`, `crates/key-review`) store every change as an
append-only event. This document fixes the event format, so other devices and a later web
screener can exchange events, and proposes how sync and web sharing could be built on
Cloudflare. **Nothing here is deployed or configured anywhere: it is a design only.**

## The event

```json
{
  "id": "0193c1f0-6a2e-7c41-9d0e-3f1a2b4c5d6e",
  "reviewId": "0193c1e0-0000-7000-8000-000000000001",
  "at": 1764230400123,
  "actor": "m1a2b3c4d",
  "device": "d0f3e2a1b4c5",
  "kind": "decision",
  "version": "0193c1e0-1111-7000-8000-000000000002",
  "recordId": "0193c1e5-2222-7000-8000-000000000003",
  "payload": { "stage": "ta", "value": "exclude", "reasons": ["c-population"], "note": "", "evidence": [] }
}
```

- `id`: a UUIDv7 (RFC 9562), made on the device that wrote the event: 48 bits of milliseconds,
  a 12-bit counter that keeps ids made in the same millisecond on one device in order, and 62
  random bits. Globally unique without coordination.
- `at`: the device's clock in ms. With `id` it gives the replay order `(at, id)`, the same on
  every device.
- `actor`: the reviewer's profile id (`rules` for automatic decisions by criteria linked to
  metadata, `system` for imports, `ai` for suggestions).
- `device`: a random id per Key installation and workspace, for diagnostics and sync cursors.
- `version`: the `protocol.set` event in force when the event was written. Decisions keep the
  protocol version they were made under.
- `payload`: by kind (below). Unknown fields are kept; unknown kinds are kept and ignored, so an
  older Key can carry a newer Key's events.

A review file (`.keyreview.json`, Export review file) is
`{ "format": "key-review", "version": 1, "review": {…}, "events": [ … ] }`. Importing one into a
workspace that has the review already adds the events it lacks — the same merge sync would do.

### Payloads

| kind | payload |
|---|---|
| `review.create` | `{ name }` |
| `review.rename` | `{ name }` |
| `review.archive` | `{ archived }` |
| `protocol.set` | `{ protocol, note, amend }`: the whole protocol; `amend` while no decision exists under the current version |
| `criteria.alias` | `{ aliases: { oldReasonId: criterionId } }`: written once when a review from before criteria and reasons were one list is opened |
| `team.set` | `{ members: [{ id, name, roles, initials }] }` |
| `batch.add` | `{ batch: { id, kind, group, name, fileName, strategy, searchedAt, count, perSource, dbRunId, duplicatesRemoved, note } }` |
| `batch.remove` | `{ batchId }` |
| `records.add` | `{ batchId, records: [RecordMeta …] }` (≤ 500 per event) |
| `dedup.candidates` | `{ pairs: [{ a, b, score, reason }] }` |
| `dedup.set` | `{ duplicateOf, auto }` or `{ distinctFrom }` (record in `recordId`) |
| `decision` | `{ stage, value, reasons, note, evidence: [{ quote, page, annotationId }] }`; `reasons` are the ids of the criteria it fails (old reason ids resolve through `criteria.alias`) |
| `decision.retract` | `{ target }`: the id of the decision or resolution taken back |
| `resolve` | `{ stage, value, reasons, note, auto? }`: a final decision (conflict resolved, or a rule's) |
| `note` | `{ text, noteId? }` |
| `labels` | `{ recordIds, add, remove }` |
| `fulltext.set` | `{ status?, reason?, sourceId? }` |
| `assign` | `{ stage, mode, reviewers: [{ id, share }], double, seed, snapshot }` |
| `pilot.set` | `{ id, name, stage, records, reviewers, open, seed }` |
| `rescreen.flag` | `{ stage, recordIds, clear? }` |
| `extract.value`, `extract.final` | `{ formId, fieldId, value, quote, page, sourceId, suggested }` |
| `ai.suggest` | `{ stage, value, score, rationale, model }` |
| `analysis.set` | `{ id, … }` |
| `protocol.register` | `{ registry, id, date, url }` (a later one corrects the details; `{ deleted: true }` withdraws it) |
| `checklist.note` | `{ list, item, location, text }` (last writer wins per list and item; both empty removes it) |
| `search.source` | `{ batchId, source, platform?, coverage?, searchedAt?, strategy?, limits?, noLimits?, filters?, notes?, searcher? }` (a patch per import and database) |
| `search.peer_review`, `search.prior` | `{ id, … }` or `{ id, deleted: true }` |
| `rob.tool` | `{ tool }` (a tool defined or edited in the review) or `{ id, deleted }` |
| `rob.setup` | `{ assessors?, blind?, tool }` |
| `rob.study` (record) | `{ tool, results? }` |
| `rob.answer` (record) | `{ result, tool, toolVersion, domain, question?, value, reason, support, migratedFrom? }`: one assessor's answer, or (no question) domain or overall judgement |
| `rob.evidence` (record) | `{ result, tool, domain, id, text, page, rects, hash, removed? }` |
| `rob.complete` (record) | `{ result, tool, complete }` |
| `rob.final` (record) | `{ result, tool, toolVersion, domain, value, note }`: the agreed judgement |
| `grade.set` | `{ key: "outcome\|time point", rating }` or `{ key, deleted }` |
| `grade.order` | `{ order: [key] }` |

### Why merging never conflicts

- Events are immutable and identified by id: merging two logs is a set union.
- State is a fold over the union in `(at, id)` order, so every device derives the same state.
- Each reviewer's decision is its own slot (record × stage × reviewer): two reviewers deciding
  the same record at the same time is the normal case, not a conflict. A *screening* conflict
  (they disagree) is review data, shown for resolution.
- Slots one person edits on two devices offline (their own decision, a protocol amendment)
  resolve last-writer-wins on `(at, id)`; the earlier event stays in the audit trail.
- Undo is an event (`decision.retract`) naming its target, so it merges like any other.
- Clock skew only changes which of two concurrent edits by *the same person* wins; a sync server
  can stamp a received time for diagnostics without changing the order.

`crates/key-review/src/tests.rs` (`concurrent_devices_merge_without_conflict`) checks that two
stores screening independently converge after exchanging logs.

## Proposal: sync and web sharing on Cloudflare

Goal: a team works on one review from several Macs, and people without Key (a second screener,
a supervisor) can screen in a browser.

### Pieces

- **One Durable Object per review** (`ReviewRoom`). It holds the review's event log in its own
  SQLite storage (Durable Objects with SQLite), accepts events, assigns each a server sequence
  number, and fans new events out to connected clients over WebSockets (hibernatable, so idle
  rooms cost nothing). It enforces who may append what (below).
- **A Worker** in front: authentication, routing `/reviews/:id/*` to the room, issuing share
  links, serving the web screener's static assets.
- **D1** for what crosses reviews: accounts, review memberships and roles, share links,
  audit of administrative actions. No review content.
- **R2** (optional) for review exports and large attachments; PDFs are not uploaded by
  default (copyright: each reviewer brings their own full texts).

### Protocol

- `GET /reviews/:id/events?after=<seq>` → events after a server sequence, paged.
- `POST /reviews/:id/events` with a batch of events → `{ accepted: [ids], seq }`. Idempotent:
  ids already stored are acknowledged, not duplicated.
- `GET /reviews/:id/socket` → WebSocket; the server pushes `{ seq, events }` as they arrive.
- Key keeps a cursor (`seq`) per review and device; offline work is appended locally and pushed
  when online. Since merging is a set union, retries are always safe.

### Authentication and permissions

- Key signs in with a passkey (WebAuthn) or an emailed one-time link; the Worker issues a
  short-lived token. Reviewer profile ids become account ids when a local review is first
  shared (a `team.set` mapping local profiles to accounts).
- Roles from `team.set` (owner, reviewer, tie-breaker) are checked by the room on append:
  only owners write `protocol.set`, `team.set`, `assign`, `pilot.set`, `batch.*`; a reviewer's
  `decision` must carry their own `actor`; `resolve` needs the tie-breaker or owner role when
  the protocol says a third person resolves.
- **Blind mode on the server**: the room filters what it sends. A reviewer's stream omits other
  reviewers' `decision` and `note` events on a record until the record leaves "needs another
  reviewer" (the same rule as `views.rs`), so a browser cannot peek. Owners can choose to see
  everything only with blind mode off.
- Share links grant one role on one review, expire, and can be revoked (D1).

### The web screener

A small static app (served by the Worker) for title/abstract and full-text screening:

- Needs: the protocol (criteria, keywords, rules), the records it is assigned (metadata
  and abstract from `records.add`), its own decisions, and resolved conflicts. Derived state is
  computed in the browser by the same fold, compiled from `crates/key-review` to WebAssembly
  (the crate has no I/O in `derive.rs`, `rules.rs`, `stats.rs`), so web and Mac agree exactly.
- Keyboard-first like Key: I / E / M, the failed criterion by number, undo, notes, labels.
- Full text: a link to the DOI and a place to upload the reviewer's own PDF to their browser
  only; quotes typed or pasted with a page number.
- Writes events with `device` = the browser's id and `actor` = the signed-in account.

### Costs and limits

- Records arrive in chunks of 500 per event, so a 20,000-record review is about 40 events of a
  few hundred KB; Durable Object storage and WebSocket messages handle this comfortably.
- A room's state is the log; snapshots (a periodic compacted state blob) speed up first loads
  for large reviews but are an optimisation, never the source of truth.

### Not decided yet

- Whether PDFs may be shared within a team (licensing differs by institution).
- Account recovery and organisation-wide administration.
- End-to-end encryption of payloads (the room would then need decisions' metadata in clear to
  enforce blind mode, or blind mode would move entirely to clients).
