# Consent Tracker pipeline

The pipeline behind the [OUSD Consent Tracker](https://oakvs.world/consent-tracker). It pulls OUSD Board consent reports from Legistar, normalizes and validates them, and publishes versioned JSON under `data/published/`, which the site reads. `consent run` does one full update cycle and is meant to run every 30 minutes.

## Commands

```bash
npm run consent:run -- --dry-run                     # one update cycle on a scratch copy; prints what would change
npm run consent:run -- --no-push                     # one update cycle; commits locally, no push or deploy
npm run consent:run                                  # one update cycle: commit, push, then POST $VERCEL_DEPLOY_HOOK_URL
npm run consent:llm -- [--key K]                     # just the LLM step (summaries, second readings), then rebuild; no git
npm run consent:llm-compare -- --key 2026-09-23 --sample 20   # redo a meeting's LLM step on a scratch copy and compare
npm run consent:discover -- --date 2026-09-23        # resolve EventId, print consent item count
npm run consent:ingest -- --key 2026-09-23 [--event 5810]
npm run consent:backfill -- --from 2025-08-01 --to 2026-09-30 [--limit N] [--force]
npm run consent:import-prototype                     # seed 2026-06-24 enrichments from the v1 prototype
npm run consent:build                                # rebuild every published file
npm run consent:upcoming                             # detect the next Board meeting → published/upcoming.json (live)
npm test
```

## Data layout (`data/`)

| Path | Stands in for | Notes |
|---|---|---|
| `meetings.json` | Postgres `meetings` | Registry. Meeting key is `YYYY-MM-DD`, or `-special` on a two-meeting day. |
| `raw/{key}.json` | `raw_snapshots` + `items` | Normalized Legistar. **Source of truth**, committed. |
| `enrichments/{key}.json` | `enrichments` | LLM output keyed by file number, with `modelId`, `promptVersion` and `cacheKey`. |
| `verifications/{key}.json` | — | Independent second readings, tied to the enrichment they checked by its `cacheKey`. |
| `llm-state.json` | — | LLM bookkeeping: monthly spend, and items whose replies kept failing (retried once a day, given up after 3 days). Not published. |
| `overrides/{key}.json` | NocoDB `overrides` | Human edits. They always win and are never overwritten by re-enrichment. |
| `vendors/aliases.json` | `vendors.aliases` | Normalized name → vendor number or canonical name. |
| `published/` | what the site reads | Fully derived. `build` regenerates it byte-identically. |
| `exports/` | CSVs + `datapackage.json` | Also derived by `build`: `items.csv`, `meetings/{key}.csv`, `meetings.csv`, `vendors.csv`. Columns are defined once in `build/exports.ts`. |
| `fixtures/golden/` | §14 golden set | Seeded from v1; **hand-verify, then set `verified: true`**. |

The Legistar response cache lives in `.cache/legistar/` (gitignored, and never published: it holds verbatim responses, including staff emails). A backfill re-run makes no network calls for meetings marked `final`.

## Update cycle (`consent run`)

The data repo is the state; there is no database. Each run:

1. **Upcoming + discovery** (1 request): future-dated matters → `published/upcoming.json`, and any confirmed new meeting date (≥ 5 items filed as `Board, General Consent Report`) is added to the registry as `discovered`, with its kind inferred from the 2nd/4th-Wednesday cadence. `upcoming.json` is only rewritten when the next meeting or its counts change.
2. **Resolve** (only when a meeting from 14 days ago to 14 days ahead has no EventId): probe the EventIds after `lastKnownEventId` once, and match by file-number overlap. Past meetings try matter histories first.
3. **Open meetings** (1 request each): re-fetch the event items and compare a hash with `eventItemsHash`. On a change, ingest incrementally: rows identical to the stored snapshot keep their matter fields, and only new or changed rows fetch their matter. Outcomes (histories and roll calls) are refreshed once a day (`historiesCheckedOn`) from the meeting date until the meeting is `final`: 14+ days after it once every item has a later action, or 180 days after it regardless. An agenda with no consent section yet stays open until the meeting date has passed.
4. **Build**, then commit `data/` if anything changed (`2026-10-14: agenda posted — 87 items`), push, and call the deploy hook if `published/` changed. A rejected push resets to the starting commit, pulls, and runs again (up to 3 times).

A quiet run costs about 15 Legistar requests. Runs refuse to start on a dirty work tree, and a lock file (`.cache/run.lock`) keeps two runs on one machine from overlapping. `--summary run.json` writes the run's changes as JSON for alerts.

5. **LLM publish**: summaries for new or changed items, then second readings, then build → commit (`2026-10-14: summaries — 87 items, 24 second readings (2 flagged for review)`) → push → deploy hook. Skipped without `ANTHROPIC_API_KEY` or with `--no-llm`. Raw data is already public by then; items show "Summary pending" until this lands, and a failed step is retried by the next run. If the step dies part-way, what it finished is still committed.

## Meeting → EventId

`/events` is broken for OUSD, so discovery uses two routes:

1. **history** (past meetings): matters by agenda date → their histories → `MatterHistoryEventId` on Board of Education entries that day.
2. **probe** (upcoming meetings, before any history exists): sequential EventIds after the last known one, matched by ≥80% file-number overlap.

## Next meeting (`consent:upcoming`)

Even single events (`/events/{id}`) error for OUSD, so the next meeting is inferred from **matters** with a future `MatterAgendaDate`: staff file items with a target date weeks before the agenda is published. A date counts once ≥ 5 items are filed as `Board, General Consent Report` for it (within 90 days), which filters out stray or mis-dated items (one is dated 3036). The result is a preview: it has no time or meeting type, and items can move until the agenda is published. The landing page shows it only while the date is ahead and newer than the latest published meeting. `build` doesn't touch `published/upcoming.json`.

## LLM steps (Claude API)

Code in `llm/`. One item per request, with structured outputs constraining the reply's shape and code checking its values; a failed check goes back to the model, up to 3 attempts. The long system prompt is cached.

| Step | Model (pinned) | Prompt | Checks |
|---|---|---|---|
| Summary | `claude-opus-5-5`, effort `high` | `prompts/enrich.v4.md` | `checkEnrichment` (schema, evidence verbatim, every amount in the text), the same as `enrich-check` |
| Second reading | `claude-sonnet-5-5`, effort `high` | `prompts/verify.v2.md` | `checkVerification`, the same as `verify-check` |
| Money tiebreak (third reading) | `claude-opus-5-5`, effort `high` | `prompts/verify.v2.md` | same |

- **What gets a summary:** items with no record, or whose text or title changed since their record (the record's `cacheKey` no longer matches). Changing the model or prompt does not redo existing summaries; use `llm-compare` first, then delete records to redo them.
- **What gets a second reading** is unchanged from the agent workflow (`tasksForMeeting`): the top 20 amounts per meeting, money that fails a check, every suggested problem in the text, and headlines that name an individual. The reader never sees the first reading's numbers. A totals-changing disagreement gets a third reading from a different model, and code takes the majority.
- **Records** carry the `modelId` that actually answered. Server-side refusal fallbacks are on (`fallbacks: "default"`), so a declined request may be answered by a fallback model, and the record says so.
- **Failures** (checks still failing after 3 attempts, or a decline) are logged in `llm-state.json`. Each item is retried at most once a day and given up on after 3 days, so one stubborn item can't cost money every 30 minutes.
- **Spend:** each run's estimated cost is added to `llm-state.json`. The step stops for the month at `CONSENT_LLM_MONTHLY_CAP_USD` (default $25). Also set a spend limit on the Anthropic API key itself.
- **Overrides:** override models with `CONSENT_ENRICH_MODEL`, `CONSENT_VERIFY_MODEL` and `CONSENT_TIEBREAK_MODEL`.

Locally, put the key in `.env` (gitignored) and run with `npx tsx --env-file=.env pipeline/cli.ts <command>`. The agent workflow (`enrich-export` / `enrich-check` / `enrich-import`, and the `verify-*` equivalents) still works for backfills.

## Known quirks found while building this

- `/events` and `/events/{id}` return an error for every OUSD event (HTTP 400 as of October 2026; `events-check` re-tests it quarterly). `/events/{id}/eventitems`, matters and histories work, so meetings are found from future-dated matters and EventId probing instead.
- When the motion text says "Motion failed" or "Motion carried", it beats Legistar's `Pass` flag: June 15, 2026 says Pass for a failed vote. Action names also beat the consent flag.
- Actions on a whole consent report (postponed, failed) become a meeting note, not flags on every item.
- Vendor numbers: only 4–8 digit codes are kept. Leading-zero variants are the same vendor only when the names also match, and vendor histories are matched exactly, never by substring.
- Staff sometimes type their own email into a free-text field (e.g. the funding source on file 21-3054). Email-shaped text is stripped from those fields on import.
- `EventItemConsent` is unreliable: 24 of June 24's 263 consent items had it set to 0. The section is found by its header row plus the agenda-letter prefix.
- The v1 prototype's `group` values were wrong for 30 items: closed-session headers leaked in because rows weren't sorted by sequence. The live ingest is correct, and June 24's raw now comes from Legistar.
- June 24, 2026: Legistar dates 245 adoptions **June 24**. About 17 pulled items were decided June 29 as Unfinished Business. The prototype note ("not taken up June 24") was wrong; the meeting note is now generated from the histories.
- `MatterEXText1` (vendor no.) sometimes holds `N/A`, a file number, or the code twice. Only numeric codes are kept.
- The June 29 special (event 5786) has no consent section, so it's registered as `skipped`.
