# Runbook

How to operate the OUSD Consent Tracker pipeline: what normally happens, how to check on it, and what to do when something goes wrong. Background on how the pipeline works is in [`pipeline/README.md`](pipeline/README.md).

## Normal operation

`consent run` runs every 30 minutes. A typical run makes about 15 Legistar requests, finds nothing new, and exits without a commit. When something changes, it commits `data/`, pushes, and calls the Vercel deploy hook if `data/published/` changed.

You'll see these commits:

| Commit | Meaning |
|---|---|
| `upcoming: 2026-10-14, 74 consent items filed so far` | Staff are filing items for the next meeting. |
| `2026-10-14: meeting detected from future-dated items` | A new meeting date has enough consent items to count. |
| `2026-10-14: meeting found (event 5825, via probe)` | Its Legistar EventId was found. The agenda is being built. |
| `2026-10-14: agenda posted — 87 items` | The official text is live, with "Summary pending" on each item. |
| `2026-10-14: summaries — 87 items, 24 second readings (2 flagged for review)` | The LLM step finished for those items. |
| `2026-10-14: agenda revised — 2 added, 1 revised` | Staff changed the agenda after it was posted. |
| `2026-10-14: outcomes updated — 85 items` | The daily outcome check found new actions or votes (from the meeting date until the meeting is final). |
| `registry: routine check` | Bookkeeping only (e.g. the daily outcome check found nothing). No deploy. |

The meeting cadence: regular meetings are on the 2nd and 4th Wednesdays at 4 p.m. The agenda is legally due 72 hours before a regular meeting (Sunday 4 p.m.) and 24 hours before a special one.

## Commands

```bash
npm run consent:run -- --dry-run                 # what a run would do, on a scratch copy; never calls the Claude API
npm run consent:run -- --no-push                 # a real run that commits locally only
npm run consent:run -- --no-llm                  # skip the LLM step
npm run consent:llm -- --key 2026-10-14          # just the LLM step for one meeting, then rebuild (no git)
npm run consent:build                            # rebuild published/ and exports/ from the inputs
npm run consent:discover -- --date 2026-10-14    # find a meeting's EventId by hand
npm run consent:ingest -- --key 2026-10-14 [--event 5825]
npm run consent:llm-compare -- --key 2026-09-23 --sample 20
npm run schema                                   # regenerate schema/ after changing packages/consent-schema
npm test
```

Locally, keep secrets in `.env` (gitignored) and run with `npx tsx --env-file=.env pipeline/cli.ts <command>`.

## Configuration

| Variable | Used for | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | The LLM step. Without it, runs publish official text only. | — |
| `VERCEL_DEPLOY_HOOK_URL` | Rebuilding the site after a push that changed `published/`. | — |
| `CONSENT_LLM_MONTHLY_CAP_USD` | Stops the LLM step for the rest of the month once estimated spend reaches it. | `25` |
| `CONSENT_ENRICH_MODEL` | Summaries. | `claude-opus-5-5` |
| `CONSENT_VERIFY_MODEL` | Second readings. | `claude-sonnet-5-5` |
| `CONSENT_TIEBREAK_MODEL` | Third readings when money readings disagree. | `claude-opus-5-5` |

Also set a monthly spend limit on the Anthropic API key itself, in the Claude Console. The pipeline's cap uses estimated prices; the Console's is the real backstop.

## When something goes wrong

### A posted agenda isn't showing up

1. Check `data/published/upcoming.json`. Does it name the date? If not, fewer than 5 items are filed as `Board, General Consent Report` for that date yet.
2. Check `data/meetings.json` for the date. With no `eventId`, the event hasn't been found yet. Runs only probe for meetings from 14 days ago to 14 days ahead, and only after `lastKnownEventId`.
3. Find it by hand: `npm run consent:discover -- --date 2026-10-14`. If you know the EventId (it's in the Legistar meeting URL), ingest it directly: `npm run consent:ingest -- --key 2026-10-14 --event 5825`. Then commit; the next run picks it up from there.

An agenda that exists but has no consent section yet stays open and is re-checked every run. It's marked `skipped` only once the meeting date has passed.

### A summary is wrong

Add a correction to `data/overrides/{meetingKey}.json`, keyed by file number. Only the fields you set are replaced:

```json
{
  "meetingKey": "2026-10-14",
  "items": {
    "26-1901": {
      "fields": { "headline": "…", "money": { "thisAction": 125000 } },
      "sourceIssue": null,
      "reviewer": "Your Name",
      "reviewedAt": "2026-10-15",
      "note": "Corrected the amount: the first reading used the prior total."
    }
  }
}
```

Then run `npm run consent:build`, check the diff, and commit. Overrides always win. A `reviewedAt` marks the item `human_reviewed`. A `note` is shown publicly as a correction. An override also applies to the same file number in other meetings when the official text is identical.

### An item is `needs_review`

Its `review.alerts` in `data/published/meetings/{key}.json` says why, usually two money readings that disagree, or a money problem no second reading has resolved. Read the official text, decide, and add an override (above) with `reviewedAt` set.

### An item's summary keeps failing

Look in `data/llm-state.json` under `failures`. `lastError` says what failed. A failing item is retried once a day and given up on after 3 days; the LLM commit then says "still failing after 3 days — needs a human". Options:

- Write the summary yourself as an override.
- Or, after fixing the cause (e.g. a prompt change), delete the failure entry to retry on the next run.

The item stays "Summary pending" with its official text published in the meantime.

### The LLM step stopped: monthly cap

The LLM commit says "monthly cap reached". Spend per month is in `data/llm-state.json` under `spend`. Raise `CONSENT_LLM_MONTHLY_CAP_USD` or wait for the next month. Summaries pick up where they left off.

### Changing the model or a prompt

1. Copy the prompt to a new version (e.g. `enrich.v5.md`) rather than editing it in place, and update `ENRICH_PROMPT_VERSION` in `pipeline/llm/enrich.ts` (or `VERIFY_API_PROMPT_VERSION` in `pipeline/llm/verify.ts`).
2. Run `npm run consent:llm-compare -- --key <a recent meeting> --sample 20` and read `.cache/llm-compare-<key>.json`.
3. Existing summaries are not redone automatically. Only new or changed items get the new version. To redo a meeting, delete its records from `data/enrichments/{key}.json` and let the next run fill them in.

### A run fails

- **"work tree has uncommitted changes"**: someone left edits in the checkout. Commit or stash them.
- **"another consent run holds .cache/run.lock"**: a run is in progress, or one crashed. Locks older than 2 hours are cleared automatically; delete the file if you're sure no run is going.
- **Legistar errors (429 or 5xx)**: the client retries with backoff. If Legistar is down, the run fails and the next one tries again.
- **"push rejected 3 times"**: something else keeps pushing to the data repo. Find it; only one scheduler should push.
- **The LLM step failed part-way** (e.g. an API outage): whatever it finished was committed, marked "(partial: LLM step failed)", and the next run continues.

### A meeting never becomes final

A meeting is final 14+ days after it happened, once every item has a Legistar action dated that day or later. If an item never gets one, the meeting stays open, and its outcomes are re-checked once a day (one request per item). 2026-02-11 is like this. If you've confirmed it's settled, set its `status` to `"final"` in `data/meetings.json` and commit.

### Privacy

- Staff email addresses must never be stored. `npm test` fails if any `@ousd.org` address appears under `data/`. Both Legistar import paths strip email-shaped text from the funding-source field, where staff sometimes type their address.
- Never commit or publish `.cache/`. It holds verbatim Legistar responses (with staff emails) and LLM scratch files. It's gitignored.

## Periodic

- **Quarterly:** check whether Legistar's `/events` endpoint works for OUSD again. If it does, discovery could be simplified.

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' 'https://webapi.legistar.com/v1/ousd/events?$top=1'
  ```

  Today it returns an error for every event; a `200` with JSON means it's fixed.
- **Vendor research** for new vendors is a separate, occasional batch job, not part of the 30-minute loop. See `research-*` in `pipeline/cli.ts`.

## Before merging a code change

- `npm test` passes. Among other things, it checks that `consent:build` reproduces `data/published/` and `data/exports/` exactly, that every committed file validates against `schema/`, and that `schema/` is up to date.
- If you changed `packages/consent-schema`, run `npm run schema` and commit `schema/`.
