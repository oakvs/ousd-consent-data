# Runbook

How to operate the OUSD Consent Tracker pipeline: what normally happens, how to check on it, and what to do when something goes wrong. Background on how the pipeline works is in [`pipeline/README.md`](pipeline/README.md).

## One-time setup

Done once, by a person, because each step needs an account sign-in. Check them off in order.

**1. GitHub (primary): `github.com/oakvs/ousd-consent-data`**

- Create the repo (public), push `main`, and keep `main` pushable by GitHub Actions. If you add branch protection, allow `github-actions[bot]` to push.
- **Settings → Actions → General → Workflow permissions:** "Read and write permissions".
- **Settings → Secrets and variables → Actions → Secrets:**

  | Secret | Value |
  |---|---|
  | `ANTHROPIC_API_KEY` | An API key for this project only, with a monthly spend limit set in the Claude Console. |
  | `VERCEL_DEPLOY_HOOK_URL` | Vercel → the oakvs project → Settings → Git → Deploy Hooks → create one for `main`. |
  | `NTFY_TOPIC` | A long random topic name, e.g. the output of `openssl rand -hex 16`. Anyone who knows it can read and post, so treat it as a secret. |
  | `NTFY_TOKEN` | Optional: an access token, if you reserve the topic on ntfy.sh or self-host ntfy. |
  | `CODEBERG_DEPLOY_KEY` | The private half of the Codeberg deploy key (step 2). |
  | `IA_ACCESS_KEY`, `IA_SECRET_KEY` | Optional: Internet Archive S3 keys (archive.org/account/s3.php), for release zips. |

- **Variables (optional):** `CONSENT_LLM_MONTHLY_CAP_USD` (default 25), `NTFY_SERVER` (default https://ntfy.sh), and `CODEBERG_KNOWN_HOSTS` (Codeberg's ed25519 host key line, from `ssh-keyscan -t ed25519 codeberg.org`, checked against Codeberg's published fingerprints, so the mirror never trusts a key on first use).
- Subscribe to the ntfy topic in the ntfy app on your phone, then send a test (`curl -d test https://ntfy.sh/<topic>`). On iPhone, if messages show up in the app but no banner appears, turn notifications for ntfy off and back on in iOS Settings.

**2. Codeberg (mirror): `codeberg.org/oakvs/ousd-consent-data`**

- Create the `oakvs` organization and an empty repo `ousd-consent-data`.
- Make a key for the mirror and add the public half as a deploy key **with write access** (repo → Settings → Deploy keys):

  ```bash
  ssh-keygen -t ed25519 -N '' -C 'github-actions mirror' -f codeberg-mirror
  ```

  Paste `codeberg-mirror` (the private half) into the GitHub secret `CODEBERG_DEPLOY_KEY`, then delete both files.
- The first mirror push comes from the first scheduled run, or run the `mirror` workflow by hand.

**3. Homelab standby**

- On a machine that's always on: install Node 22, clone the GitHub repo with an SSH key that can push to it (a GitHub deploy key with write access on this repo only), and create `.env` with `ANTHROPIC_API_KEY`, `VERCEL_DEPLOY_HOOK_URL` and `NTFY_TOPIC` (and `NTFY_TOKEN` if used).
- Set a git identity in that clone (e.g. `git config user.name 'consent standby'`). Turn off commit signing there unless the machine has an unlocked signing key, or cron runs will hang.
- Optional: add a `codeberg` remote with its own deploy key, so the standby also updates the mirror.
- Add the cron line from the top of `scripts/standby.sh`. Test it once by hand with `scripts/standby.sh --dry-run`.
- The homelab's own Forgejo can keep a third copy as a **pull mirror** of the GitHub repo (Forgejo → New migration → GitHub, tick "This repository will be a mirror"). That needs no secrets in CI.

**4. Zenodo (DOIs for releases)**

- Sign in to zenodo.org with GitHub, open **GitHub** in the account menu, and switch on `oakvs/ousd-consent-data`. As an org repo, it may need an org owner to approve the Zenodo app first (GitHub → oakvs → Settings → Third-party access).

**5. Check it all**

- Actions → **consent run** → Run workflow, with "Dry run" ticked. It should finish green, and the step summary should show the run.
- Then run it once without the dry run. Check the commit (if any), the Codeberg mirror, and that an ntfy message arrives for anything it published.

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
| `Vendors: 1 duplicate merged, 3 researched, 2 profiles published, 12 Legistar histories updated` | The vendor steps ran: the duplicate judge merged a vendor (the commit body says which and why), new vendors were looked up and independently reviewed (only confirmed profiles show on vendor pages), and Legistar histories were updated for vendors with new items. |
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
npm run consent:enrich-export -- --all             # chunk every item for a swarm re-run; snapshots data/enrichments to .cache/enrich/previous
npm run consent:enrich-import -- --model sonnet-agent --replace   # merge swarm output, overwriting existing records
npm run consent:category-diff                      # what moved: category matrix, movers, sub-categories (.cache/enrich/category-diff.json)
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
| `NTFY_TOPIC` | Where alerts go. Without it, alerts are only printed. | — |
| `NTFY_SERVER`, `NTFY_TOKEN` | A self-hosted or protected ntfy. | `https://ntfy.sh`, none |
| `CODEBERG_DEPLOY_KEY`, `CODEBERG_KNOWN_HOSTS` | The Codeberg mirror push (`scripts/mirror.sh`). | —, fetched with `ssh-keyscan` |
| `CONSENT_STANDBY_GRACE_MIN` | The standby skips if a CI run started within this many minutes. | `40` |

Also set a monthly spend limit on the Anthropic API key itself, in the Claude Console. The pipeline's cap uses estimated prices; the Console's is the real backstop.

## Scheduler, standby and alerts

- **GitHub Actions** (`.github/workflows/run.yml`) runs `consent run` at :07 and :37 past each hour, one at a time (concurrency group `consent-run`). Scheduled runs can start late, sometimes by 10–20 minutes. The run page's summary shows what happened.
- **The homelab standby** (`scripts/standby.sh` from cron, every 30 minutes) checks the workflow's recent runs. It runs `consent run` only if no CI run started in the last 40 minutes (or the one that did failed), then pushes to its `codeberg` remote if it has one. If both run at once, git sorts it out: the later push is rejected, and that run pulls and re-runs.
- **The dead-man switch** lives in the standby, because CI can't report its own absence. No successful run anywhere for 6 hours → an urgent alert, repeated every 6 hours, then a "succeeding again" message. If CI has stopped but the standby is covering, you get one high-priority alert a day.
- **GitHub disables schedules** in public repos after 60 days without activity. The routine bookkeeping commits count as activity, so this shouldn't happen. If it does, the standby's alert above is how you'll find out: re-enable the workflow under Actions.
- If GitHub itself is down, runs can't push, and the data waits. The Codeberg and homelab copies stay readable, and the next run catches up.

| Alert | Priority |
|---|---|
| Agenda posted, with item count | default |
| Agenda revised | low |
| Summaries published, with second readings and how many were flagged | default, or high if any are flagged |
| Items still failing after 3 days | high |
| Duplicate vendors merged, with each reason | default |
| Vendor profiles published | low |
| Vendor research still failing after 3 days | default |
| LLM step failed part-way; monthly cap reached | high |
| LLM spend crossed 80% of the monthly cap | default |
| Two failed runs in a row | urgent |
| No successful run in 6 hours (standby) | urgent |
| Codeberg mirror push failed | low |
| Quarterly Legistar `/events` check | low, or high if it works again |

## Mirrors, releases and archives

- **Codeberg** gets every push: `run.yml` mirrors after each run, and `mirror.yml` mirrors pushes made by people. The push is never forced. If someone pushes to Codeberg directly, mirroring fails until the two agree again.
- **Releases:** tag a release when a school year ends, or when a meeting worth citing goes final:

  ```bash
  gh release create v2026.10 --title 'October 2026' --notes 'Data through the October 14, 2026 meeting.'
  ```

  Zenodo mints a DOI for it. `release.yml` asks Software Heritage to archive both repos, saves the site in the Wayback Machine, and uploads a zip of `data/` to the Internet Archive if its keys are set. Software Heritage also crawls public repos on its own.

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

The LLM commit says "monthly cap reached". Spend per month is in `data/llm-state.json` under `spend`. Raise `CONSENT_LLM_MONTHLY_CAP_USD` or wait for the next month. Summaries pick up where they left off, then vendor research.

### Re-running every summary

Only for a codebook change that should apply to the whole dataset (October 2026: `enrich.v5`). Every published headline and summary changes, so this is a planned, one-shot migration:

1. Pause the scheduler: `gh workflow disable "consent run"` and stop the homelab standby if one is running. Nothing may push `main` until step 8.
2. Work on a branch. `npm run consent:enrich-export -- --all` writes a chunk per ~30 items to `.cache/enrich/` and snapshots the current `data/enrichments/` to `.cache/enrich/previous/` (once). Clear any stale `.cache/enrich/*.output.json` from earlier runs first.
3. Run the agents (a Claude Code swarm; each agent follows the prompt's "agent mode", writes its chunk's output and runs `enrich-check`), or `consent llm` for the API path after deleting the records to redo.
4. `npm run consent:enrich-import -- --model sonnet-agent --replace`.
5. `npm run consent:category-diff` and read the movers before trusting the result.
6. Replaced records invalidate their second readings; `npx tsx --env-file=.env pipeline/cli.ts llm` re-reads every meeting (raise `CONSENT_LLM_MONTHLY_CAP_USD` first).
7. `npm run consent:build`, `npm test`, update README's categorization note.
8. If the schema major changed, merge the site change first (below). Merge, push, re-enable the scheduler.

### Bumping the schema major version

Renaming or removing anything in `packages/consent-schema` is breaking: the site's build refuses data whose major version it doesn't know.

1. `SCHEMA_VERSION` in `packages/consent-schema/src/schema.ts`; `npm run schema`.
2. `data/raw/*.json` carry `schemaVersion` and must be rewritten to the new value (a one-line change per file; use `writeJson` so the formatting stays stable).
3. In `oakvs`: `SUPPORTED_SCHEMA_MAJOR` in `src/lib/consent/data.ts`, plus any renamed slugs in `src/app/consent-tracker/layout.module.scss`. Merge that before pushing the data; its own build fails on the version gate until the data lands, and Vercel keeps serving the previous deploy.

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

A meeting is final 14 or more days after it happened, once every item has a Legistar action dated that day or later. Some items never get one, so a meeting also becomes final 180 days after it, whatever Legistar shows. Until then, open meetings are re-checked every run and their outcomes once a day. To close one sooner, set its `status` to `"final"` in `data/meetings.json` and commit.

### Privacy

- Staff email addresses must never be stored. `npm test` fails if any `@ousd.org` address appears under `data/`. Both Legistar import paths strip email-shaped text from the funding-source field, where staff sometimes type their address.
- Never commit or publish `.cache/`. It holds verbatim Legistar responses (with staff emails) and LLM scratch files. It's gitignored.

## Periodic

- **Quarterly:** `events-check.yml` checks whether Legistar's `/events` endpoint works for OUSD again, and sends the answer to ntfy. If it does, meeting discovery could be simplified. To check by hand: `npx tsx pipeline/cli.ts events-check`. As of October 2026 it returns HTTP 400.
- **Vendor steps** run in the 30-minute loop after the summaries: the duplicate judge (up to 10 groups per run), Legistar histories (up to 40 vendors per run), then research (up to 4 vendors per run). If an alert says vendor work "needs a human", look at its `merge:`, `research:` or `review:` entry in `data/llm-state.json`; deleting the entry makes the next run try again. To catch up a backlog faster, run these locally and commit:

  ```bash
  npx tsx --env-file=.env pipeline/cli.ts vendor-merge --limit 50
  npx tsx pipeline/cli.ts vendor-history --update --limit 500
  npx tsx --env-file=.env pipeline/cli.ts research --limit 20
  ```

- **A wrong merge:** every merge sends an ntfy alert with its reason. To undo one, delete its entry from the `manual` section of `data/vendors/aliases.json`, move its record in `data/vendors/merge-decisions.json` from `merged` to `keptSeparate` (so it isn't judged again), run `npm run consent:build`, and commit.

## Before merging a code change

- `npm test` passes. Among other things, it checks that `consent:build` reproduces `data/published/` and `data/exports/` exactly, that every committed file validates against `schema/`, and that `schema/` is up to date.
- If you changed `packages/consent-schema`, run `npm run schema` and commit `schema/`. The oakvs site builds against this package as it is on `main`, so additions (a new flag, category or optional field) go live with the next deploy. A removal or rename is breaking: bump the major number of `SCHEMA_VERSION` and update the site first (see the comment at the top of `schema.ts`).
