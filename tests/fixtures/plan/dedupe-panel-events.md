---
feature: "Dedupe panel events"
slug: "dedupe-panel-events"
status: approved
approvedAt: "2026-11-03T15:13:15.000Z"
slices: 4
session: "01a1a1cb-cb27-747e-9beb-a4bec3b9f2fe"
generator: pi-architect
---

# Dedupe panel events

## How to build this plan

This plan was designed with the user and approved. It holds everything you need to build the feature.

1. Read the whole plan before you change any code.
2. Build the slices in order. Start a slice only when every slice it depends on is done.
3. Follow the steps of the slice. Tick each step in this file, from `- [ ]` to `- [x]`, as soon as it is done.
4. Run every verify command of the slice. Fix the code until they all pass. Then tick "Verified" and move on.
5. The decisions are final. Do not reopen them or build a rejected option. If one cannot work, stop and ask the user.
6. Stay inside the brief. Leave everything out of scope alone. Follow the existing patterns under Context.

## Brief

### Goal

Panels send the same alarm event up to five times when the network flaps. Store and show each event once, so operators see one alarm per incident.

### Constraints

- Keep the ingest latency under 200 ms at the 99th percentile.
- No new infrastructure: use Postgres, which the processor already talks to.

### Out of scope

- Deduplicating events from the legacy v1 panels.
- Changing the panel firmware.

### Done when

- Replaying the same event 5 times stores 1 row in `panel_events`.
- The alarm list shows one alarm per incident.
- `npm test` passes.

## Context

### Modules

- `src/ingest` (changes): Parses panel messages and writes them with `insertEvent`.
  - `src/ingest/processor.ts`
  - `src/ingest/schema.ts`
- `migrations` (changes): Plain SQL files, applied in name order.
- `src/ingest/dedup` (new): Builds the dedup key from panel id, event code and the panel's own timestamp.
  - `src/ingest/dedup/key.ts`
- `src/api/alarms` (read only): Reads `panel_events`.
  - `src/api/alarms/list.ts`

### Findings and existing patterns

- Panels retry with the same `sequence` number, so `panel_id` + `sequence` identifies a retry.
- `insertEvent` in src/ingest/processor.ts is the only place that writes `panel_events`.
- Tests use the `withDb` helper from tests/db.ts, which runs each test in a rolled back transaction.

### Current shape

#### Ingest today

```text
┌───────┐    ┌───────────┐    ┌──────────────┐
│ panel │───▶│ processor │───▶│ panel_events │
└───────┘    └───────────┘    └──────────────┘
```

Every retry becomes a new row.

## Decisions

These are settled. Build the chosen option. Do not reopen them.

### 1. Where do panel events get deduplicated?

Events arrive at the processor, which writes them to Postgres. The backend only reads them.

**Chosen: A. In the processor** (recommended)

Skip an event whose dedup key is already stored.

- Pro: One owner for writes
- Pro: Duplicates never reach the database
- Con: Needs a unique index to be safe under concurrency

Effort 2/5, risk 1/5.

The user said:

> Yes, and log every skipped duplicate at debug level.

Rejected:

- **B. In the backend**: Filter duplicates when the alarm list is read. Not chosen: Duplicates still fill the table; Every reader must filter.
- **C. Redis stream**: Not chosen: New infrastructure, which the brief rules out.

### 2. How long do dedup keys stay unique?

**Chosen: B. Per day**

The key includes the event's UTC date.

- Pro: A sequence reset only matters within one day
- Con: Slightly longer key

Effort 2/5, risk 1/5.

Rejected:

- **A. Forever** (recommended): A unique index on the key column. Not chosen: A panel that resets its sequence loses events.

## Design

### Ingest with dedup

```text
┌───────┐    ┌───────────┐    ┌──────────────┐
│ panel │───▶│ processor │───▶│ panel_events │
└───────┘    │ [changed] │    │ [changed]    │
             └─────┬─────┘    └──────────────┘
                   │
             ┌─────▼─────┐
             │ dedup key │
             │ [new]     │
             └───────────┘
```

The processor builds the key and lets the unique index reject a duplicate.

### A retried event

```text
panel        processor          postgres
  │ event #7     │                   │
  │─────────────▶│ insert key 7      │
  │              │──────────────────▶│ ok
  │ retry #7     │                   │
  │─────────────▶│ insert key 7      │
  │              │──────────────────▶│ conflict: skip, log debug
```

## Risks

- **High:** Old v1 panels send `sequence` 0 for every event, so their events would collapse into one. Mitigation: Skip the dedup key for v1 panels, which the processor already detects.
- **Medium:** The unique index takes a lock while it builds on a large table. Mitigation: Create it with CREATE INDEX CONCURRENTLY.
- **Low:** Operators may notice fewer alarms and ask why.

## Slices

Build order: 1, then 2 and 3 in any order, then 4.

### 1. Add the dedup key column

**Goal:** `panel_events` has a `dedup_key` column with a unique index per day.

**Depends on:** nothing

**Files:**

- `migrations/0042_panel_events_dedup_key.sql`

**Steps:**

- [ ] Add a nullable `dedup_key text` column to `panel_events` in migrations/0042_panel_events_dedup_key.sql.
- [ ] Create a unique index on `dedup_key` with CREATE INDEX CONCURRENTLY.

**Verify:**

```bash
npm run db:migrate
npm test -- tests/migrations.test.ts
```

- [ ] Verified: every command above passes.

### 2. Store dedup key

**Goal:** Every new event carries a dedup key built from panel id, sequence and UTC date.

**Depends on:** 1. Add the dedup key column

**Files:**

- `src/ingest/dedup/key.ts`
- `src/ingest/schema.ts`
- `tests/ingest/key.test.ts`

**Steps:**

- [ ] Write `dedupKey(event)` in src/ingest/dedup/key.ts: `${panelId}:${sequence}:${utcDate}`.
- [ ] Return undefined from `dedupKey` for v1 panels (`event.protocol === 1`).
- [ ] Add `dedupKey` to the `PanelEvent` type in src/ingest/schema.ts.

**Verify:**

```bash
npm test -- tests/ingest/key.test.ts
```

- [ ] Verified: every command above passes.

### 3. Show skipped duplicates in the debug log

**Goal:** A skipped duplicate logs one debug line with the panel id and the key.

**Depends on:** 1. Add the dedup key column

**Files:**

- `src/ingest/log.ts`

**Steps:**

- [ ] Add `logDuplicate(panelId, key)` to src/ingest/log.ts at debug level.

**Verify:**

```bash
npm test -- tests/ingest/log.test.ts
```

- [ ] Verified: every command above passes.

### 4. Skip duplicates on insert

**Goal:** `insertEvent` stores each event once and skips retries.

**Depends on:** 2. Store dedup key, 3. Show skipped duplicates in the debug log

**Files:**

- `src/ingest/processor.ts`
- `tests/ingest/processor.test.ts`

**Steps:**

- [ ] Change `insertEvent` in src/ingest/processor.ts to insert with ON CONFLICT (dedup_key) DO NOTHING.
- [ ] Call `logDuplicate` when the insert affected no row.
- [ ] Add a test that replays one event 5 times with `withDb` and expects 1 row.

**Verify:**

```bash
npm test -- tests/ingest/processor.test.ts
npm test
```

- [ ] Verified: every command above passes.
