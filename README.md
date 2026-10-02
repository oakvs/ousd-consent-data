# OUSD Consent Tracker: data and pipeline

Every item on the Oakland Unified School District (OUSD) Board of Education's **General Consent Report**, the batch of contracts, grants, agreements and resolutions the Board approves in a single vote, starting in August 2025. Each item comes with the official text from Legistar, a plain-English summary, a classification, and a dollar amount checked in code.

This repo is the data and the pipeline that keeps it current. The reader-friendly view is the [Consent Tracker on Oakland vs. the World](https://oakvs.world/consent-tracker).

- **26 meetings, 2,149 items, 757 vendors** so far.
- **Updated every 30 minutes.** New agendas appear within minutes of posting; summaries follow once they pass their checks.
- **Free to reuse.** Code is MIT. The project's own work (summaries, classifications, vendor profiles) is CC BY 4.0. Legistar text is public record.

## Get the data

| You want | Use |
|---|---|
| A spreadsheet | [`data/exports/items.csv`](data/exports/items.csv): one row per item, all meetings. Also [`meetings.csv`](data/exports/meetings.csv), [`vendors.csv`](data/exports/vendors.csv), and one file per meeting in [`data/exports/meetings/`](data/exports/meetings/). |
| Column definitions | [`data/exports/datapackage.json`](data/exports/datapackage.json), a [Frictionless Data Package](https://datapackage.org/) with a type and description for every column. |
| Everything, as JSON | [`data/published/`](data/published/): `index.json` (all meetings), `meetings/{key}.json` (full detail: history, votes, checks, attachments), `vendors/{key}.json`, `upcoming.json` (the next meeting). |
| Schemas | [`schema/`](schema/): JSON Schema (draft 2020-12) for every file, generated from [`packages/consent-schema`](packages/consent-schema/). |
| A fixed version to cite | Tagged releases are archived on Zenodo with a DOI; see [`CITATION.cff`](CITATION.cff). |

Files are plain JSON and CSV at stable paths, so you can read them straight from the repo, e.g. `https://raw.githubusercontent.com/oakvs/ousd-consent-data/main/data/published/index.json`. The same files are mirrored on [Codeberg](https://codeberg.org/oakvs/ousd-consent-data).

The CSVs are UTF-8 with a header row. Google Sheets opens them directly. In Excel, use **Data → From Text/CSV** so accented characters and dashes come through.

## What's official and what isn't

Every item has two layers, and the data keeps them apart.

**Official (from Legistar):** the title, the action text, the file number, the agenda number, the vendor number, the funding source, attachments, history and votes. The action text is the source of truth. Staff email addresses that Legistar includes are never stored.

**This project's reading of it (AI-written, then checked):** the headline, summary, category, action type, vendor name, schools, dollar amounts, term and flags. These are written by Claude and then checked in code before they're published:

- Every dollar amount must appear word for word in the official text, and its quoted evidence must be an exact substring of that text. Nothing is computed, rounded or inferred.
- An independent second reading, which never sees the first reading's numbers, re-reads the money on the largest items and on anything that failed a check. If two readings disagree in a way that changes totals, a third reading breaks the tie, and code (not a model) does the arithmetic.
- Problems in the official text itself (totals that don't add up, a title that names a different vendor than the action text) are published only when a second reading confirms they're material. Typos become notes.
- Organizations are always named. Individuals contracting in their own name are described by role in headlines.
- Corrections by a person (`data/overrides/`) always win, and are labeled as such.

Each item's `review_status` (in the CSV) or `review.status` (in the JSON) says where it landed: `auto_ok`, `needs_review` (an alert is open, and `review.alerts` says why), `blocked` (failed a hard check; only the official text is published), `human_reviewed`, or `pending` (no summary yet).

Spot something wrong? [Open an issue](https://github.com/oakvs/ousd-consent-data/issues) with the item's file number.

## How it stays current

`consent run` does one full update cycle. GitHub Actions runs it every 30 minutes, and a homelab machine runs the same command as a standby.

1. **Check** Legistar cheaply (about 15 requests): the next meeting, new meetings, and whether any open meeting's agenda changed.
2. **Publish the official text** as soon as an agenda appears or changes. New items show "Summary pending".
3. **Publish summaries and second readings** once they pass their checks, in a second commit.

Every change is a readable commit, such as `2026-10-14: agenda posted — 87 items` or `2026-10-14: outcomes updated — 85 items`, so the git history is an audit trail of every agenda revision and correction. Details are in [`pipeline/README.md`](pipeline/README.md); operations are in [`RUNBOOK.md`](RUNBOOK.md).

## Repo layout

```
data/
  raw/              normalized Legistar snapshots, one per meeting (the source of truth)
  enrichments/      AI summaries, with the model and prompt version that wrote each
  verifications/    independent second readings
  overrides/        corrections by a person; they always win
  legistar/vendors/ every Legistar record per vendor
  vendor-research/  AI vendor profiles, with checks and an independent review
  published/        what the site reads; fully derived, rebuilt byte-for-byte by `consent:build`
  exports/          CSVs and datapackage.json, also derived
  meetings.json     the meeting registry
  llm-state.json    LLM bookkeeping: monthly spend, items that keep failing
packages/consent-schema/   zod schemas and pure helpers, shared with the site
pipeline/                  the CLI: Legistar client, normalize, validate, build, LLM steps, prompts, tests
schema/                    generated JSON Schema
```

## Run it yourself

Node 22 or later.

```bash
npm ci
npm test                               # includes: published data rebuilds identically, every file validates
npm run consent:build                  # rebuild data/published and data/exports from the inputs
npm run consent:run -- --dry-run       # one live update cycle on a scratch copy; changes nothing
```

The LLM steps need `ANTHROPIC_API_KEY`. Without it, `consent run` still publishes the official text and skips the summaries.

## License and citation

- **Code:** [MIT](LICENSE).
- **Data:** the project's own work (headlines, summaries, classifications, flags, second readings and vendor profiles) is [CC BY 4.0](LICENSE-DATA). Please credit "OUSD Consent Tracker, Oakland vs. the World (oakvs.world)" and link to this repo.
- **Official Legistar text and records** are public records of the Oakland Unified School District.

To cite a specific version, use the Zenodo DOI of a tagged release. [`CITATION.cff`](CITATION.cff) has the details, and GitHub's "Cite this repository" button reads it.
