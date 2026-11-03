import type { Architecture } from "../../../src/state/types.ts";

/** 2026-11-03T15:13:15.000Z. */
export const APPROVED_AT = Date.UTC(2026, 10, 3, 15, 13, 15);

/**
 * A complete, approved architecture for one realistic feature. Reused by the plan writer, the Blueprint
 * data and the progress tests. Change it only together with the snapshot in `dedupe-panel-events.md`.
 */
export function fullArchitecture(): Architecture {
	return {
		feature: "Dedupe panel events",
		slug: "dedupe-panel-events",
		startedAt: APPROVED_AT - 3_600_000,
		phase: "blueprint",
		status: "working",
		approvedAt: APPROVED_AT,
		brief: {
			goal: "Panels send the same alarm event up to five times when the network flaps. Store and show each event once, so operators see one alarm per incident.",
			constraints: [
				"Keep the ingest latency under 200 ms at the 99th percentile.",
				"No new infrastructure: use Postgres, which the processor already talks to.",
			],
			outOfScope: ["Deduplicating events from the legacy v1 panels.", "Changing the panel firmware."],
			doneWhen: [
				"Replaying the same event 5 times stores 1 row in `panel_events`.",
				"The alarm list shows one alarm per incident.",
				"`npm test` passes.",
			],
		},
		modules: [
			{
				path: "src/ingest",
				role: "touched",
				files: ["src/ingest/processor.ts", "src/ingest/schema.ts"],
				note: "Parses panel messages and writes them with `insertEvent`.",
			},
			{ path: "src/api/alarms", role: "context", files: ["src/api/alarms/list.ts"], note: "Reads `panel_events`." },
			{
				path: "src/ingest/dedup",
				role: "new",
				files: ["src/ingest/dedup/key.ts"],
				note: "Builds the dedup key from panel id, event code and the panel's own timestamp.",
			},
			{ path: "migrations", role: "touched", files: [], note: "Plain SQL files, applied in name order." },
		],
		findings: [
			{
				id: "f1",
				text: "Panels retry with the same `sequence` number, so `panel_id` + `sequence` identifies a retry.",
			},
			{ id: "f2", text: "`insertEvent` in src/ingest/processor.ts is the only place that writes `panel_events`." },
			{
				id: "f3",
				text: "Tests use the `withDb` helper from tests/db.ts, which runs each test in a rolled back transaction.",
			},
		],
		risks: [
			{
				id: "r1",
				text: "Old v1 panels send `sequence` 0 for every event, so their events would collapse into one.",
				severity: "high",
				mitigation: "Skip the dedup key for v1 panels, which the processor already detects.",
			},
			{
				id: "r2",
				text: "The unique index takes a lock while it builds on a large table.",
				severity: "medium",
				mitigation: "Create it with CREATE INDEX CONCURRENTLY.",
			},
			{ id: "r3", text: "Operators may notice fewer alarms and ask why.", severity: "low" },
		],
		decisions: [
			{
				id: "q1",
				question: "Where do panel events get deduplicated?",
				context: "Events arrive at the processor, which writes them to Postgres. The backend only reads them.",
				options: [
					{
						id: "A",
						title: "In the processor",
						summary: "Skip an event whose dedup key is already stored.",
						pros: ["One owner for writes", "Duplicates never reach the database"],
						cons: ["Needs a unique index to be safe under concurrency"],
						effort: 2,
						risk: 1,
					},
					{
						id: "B",
						title: "In the backend",
						summary: "Filter duplicates when the alarm list is read.",
						pros: ["No write path change"],
						cons: ["Duplicates still fill the table", "Every reader must filter"],
						effort: 3,
						risk: 2,
					},
					{
						id: "C",
						title: "Redis stream",
						pros: ["Scales out"],
						cons: ["New infrastructure, which the brief rules out"],
						effort: 4,
						risk: 3,
					},
				],
				recommendation: "A",
				chosen: "A",
				comment: "Yes, and log every skipped duplicate at debug level.",
			},
			{
				id: "q2",
				question: "How long do dedup keys stay unique?",
				options: [
					{
						id: "A",
						title: "Forever",
						summary: "A unique index on the key column.",
						pros: ["Simple"],
						cons: ["A panel that resets its sequence loses events"],
						effort: 1,
						risk: 3,
					},
					{
						id: "B",
						title: "Per day",
						summary: "The key includes the event's UTC date.",
						pros: ["A sequence reset only matters within one day"],
						cons: ["Slightly longer key"],
						effort: 2,
						risk: 1,
					},
				],
				recommendation: "A",
				chosen: "B",
			},
		],
		diagrams: [
			{
				id: "g1",
				phase: "explore",
				title: "Ingest today",
				body: "┌───────┐    ┌───────────┐    ┌──────────────┐\n│ panel │───▶│ processor │───▶│ panel_events │\n└───────┘    └───────────┘    └──────────────┘",
				caption: "Every retry becomes a new row.",
			},
			{
				id: "g2",
				phase: "design",
				title: "Ingest with dedup",
				body: "┌───────┐    ┌───────────┐    ┌──────────────┐\n│ panel │───▶│ processor │───▶│ panel_events │\n└───────┘    │ [changed] │    │ [changed]    │\n             └─────┬─────┘    └──────────────┘\n                   │\n             ┌─────▼─────┐\n             │ dedup key │\n             │ [new]     │\n             └───────────┘",
				caption: "The processor builds the key and lets the unique index reject a duplicate.",
			},
			{
				id: "g3",
				phase: "design",
				title: "A retried event",
				body: "panel        processor          postgres\n  │ event #7     │                   │\n  │─────────────▶│ insert key 7      │\n  │              │──────────────────▶│ ok\n  │ retry #7     │                   │\n  │─────────────▶│ insert key 7      │\n  │              │──────────────────▶│ conflict: skip, log debug",
			},
		],
		slices: [
			{
				id: "s1",
				title: "Add the dedup key column",
				goal: "`panel_events` has a `dedup_key` column with a unique index per day.",
				dependsOn: [],
				files: ["migrations/0042_panel_events_dedup_key.sql"],
				steps: [
					"Add a nullable `dedup_key text` column to `panel_events` in migrations/0042_panel_events_dedup_key.sql.",
					"Create a unique index on `dedup_key` with CREATE INDEX CONCURRENTLY.",
				],
				verify: ["npm run db:migrate", "npm test -- tests/migrations.test.ts"],
			},
			{
				id: "s2",
				title: "Store dedup key",
				goal: "Every new event carries a dedup key built from panel id, sequence and UTC date.",
				dependsOn: ["s1"],
				files: ["src/ingest/dedup/key.ts", "src/ingest/schema.ts", "tests/ingest/key.test.ts"],
				steps: [
					"Write `dedupKey(event)` in src/ingest/dedup/key.ts: `${panelId}:${sequence}:${utcDate}`.",
					"Return undefined from `dedupKey` for v1 panels (`event.protocol === 1`).",
					"Add `dedupKey` to the `PanelEvent` type in src/ingest/schema.ts.",
				],
				verify: ["npm test -- tests/ingest/key.test.ts"],
			},
			{
				id: "s3",
				title: "Show skipped duplicates in the debug log",
				goal: "A skipped duplicate logs one debug line with the panel id and the key.",
				dependsOn: ["s1"],
				files: ["src/ingest/log.ts"],
				steps: ["Add `logDuplicate(panelId, key)` to src/ingest/log.ts at debug level."],
				verify: ["npm test -- tests/ingest/log.test.ts"],
			},
			{
				id: "s4",
				title: "Skip duplicates on insert",
				goal: "`insertEvent` stores each event once and skips retries.",
				dependsOn: ["s2", "s3"],
				files: ["src/ingest/processor.ts", "tests/ingest/processor.test.ts"],
				steps: [
					"Change `insertEvent` in src/ingest/processor.ts to insert with ON CONFLICT (dedup_key) DO NOTHING.",
					"Call `logDuplicate` when the insert affected no row.",
					"Add a test that replays one event 5 times with `withDb` and expects 1 row.",
				],
				verify: ["npm test -- tests/ingest/processor.test.ts", "npm test"],
			},
		],
		reviews: [],
	};
}
