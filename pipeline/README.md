# Consent Tracker pipeline

The pipeline behind `/consent-tracker`. It pulls OUSD Board consent reports from Legistar, normalizes and validates them, and publishes versioned JSON the site reads at build time. The full design is in `docs/superpowers/plans/ousd-consent-reader-plan.md`. This folder is the local prototype of its `consent-pipeline` package; n8n can later call this same CLI.

## Commands

```bash
npm run consent:seed-registry                        # meetings.json from ~/ousd-mseg/board-agendas filenames
npm run consent:discover -- --date 2026-09-23        # resolve EventId, print consent item count
npm run consent:ingest -- --key 2026-09-23 [--event 5810]
npm run consent:backfill -- --from 2025-08-01 --to 2026-09-30 [--limit N] [--force]
npm run consent:import-prototype                     # seed 2026-06-24 enrichments from the v1 prototype
npm run consent:build                                # rebuild every published file
npm run consent:upcoming                             # detect the next Board meeting → published/upcoming.json (live)
npm test
```

After publishing a new meeting, restart `npm run dev`: dev caches `generateStaticParams`.

## Data layout (`data/`)

| Path | Stands in for | Notes |
|---|---|---|
| `meetings.json` | Postgres `meetings` | Registry. Meeting key is `YYYY-MM-DD`, or `-special` on a two-meeting day. |
| `raw/{key}.json` | `raw_snapshots` + `items` | Normalized Legistar. **Source of truth**, committed. |
| `enrichments/{key}.json` | `enrichments` | LLM output keyed by file number, with `modelId`, `promptVersion` and `cacheKey`. |
| `overrides/{key}.json` | NocoDB `overrides` | Human edits. They always win and are never overwritten by re-enrichment. |
| `vendors/aliases.json` | `vendors.aliases` | Normalized name → vendor number or canonical name. |
| `published/` | `ousd-consent-data` repo | Fully derived. `build` regenerates it byte-identically. |
| `fixtures/golden/` | §14 golden set | Seeded from v1; **hand-verify, then set `verified: true`**. |

The Legistar response cache lives in `.cache/legistar/` (gitignored). A backfill re-run makes no network calls for meetings marked `final`.

## Meeting → EventId

`/events` is broken for OUSD, so discovery uses two routes:

1. **history** (past meetings): matters by agenda date → their histories → `MatterHistoryEventId` on Board of Education entries that day.
2. **probe** (upcoming meetings, before any history exists): sequential EventIds after the last known one, matched by ≥80% file-number overlap.

## Next meeting (`consent:upcoming`)

Even single events (`/events/{id}`) error for OUSD, so the next meeting is inferred from **matters** with a future `MatterAgendaDate`: staff file items with a target date weeks before the agenda is published. A date counts once ≥ 5 items are filed as `Board, General Consent Report` for it (within 90 days), which filters out stray or mis-dated items (one is dated 3036). The result is a preview: it has no time or meeting type, and items can move until the agenda is published. The landing page shows it only while the date is ahead and newer than the latest published meeting. `build` doesn't touch `published/upcoming.json`.

## Enrichment interface (not built yet)

There are no live LLM calls in the prototype. To add them, write `enrich/` so it:

- Reads `raw/{key}.json` and, for each item with no current record, calls the model with the codebook prompt (`prompts/enrich.v2.md`, see §8.1) and a strict JSON schema generated from `Enrichment` in `src/lib/consent/schema.ts`. Input: `{agendaNumber, file, title, text, matterType, presenter, group, fundingSource}`.
- Keys the cache with `enrichmentCacheKey(text, title, promptVersion, modelId)` from `import/prototype.ts`, and skips items whose key is unchanged.
- On a schema or check failure, retries up to 2 times, feeding back the failing check from `validate/checks.ts`.
- Writes `EnrichmentRecord`s to `enrichments/{key}.json`. `build` then does the rest: overrides, checks, review routing, derived flags and totals.

Run the golden set before switching `modelId` or `promptVersion`.

## Known quirks found while building this

- `EventItemConsent` is unreliable: 24 of June 24's 263 consent items had it set to 0. The section is found by its header row plus the agenda-letter prefix.
- The v1 prototype's `group` values were wrong for 30 items: closed-session headers leaked in because rows weren't sorted by sequence. The live ingest is correct, and June 24's raw now comes from Legistar.
- June 24, 2026: Legistar dates 245 adoptions **June 24**. About 17 pulled items were decided June 29 as Unfinished Business. The prototype note ("not taken up June 24") was wrong; the meeting note is now generated from the histories.
- `MatterEXText1` (vendor no.) sometimes holds `N/A`, a file number, or the code twice. Only numeric codes are kept.
- The June 29 special (event 5786) has no consent section, so it's registered as `skipped`.
