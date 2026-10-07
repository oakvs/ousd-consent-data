# Category codebook v5: revised categories, special-education sub-categories, full re-run

**Date:** 2026-10-06
**Status:** approved in conversation; awaiting written review
**Repos:** `ousd-consent-data` (this repo) and `oakvs` (site, small lockstep change)

## 1. Why

The published data gives every consent item one of 12 categories. Two problems showed up in use:

1. **Special education is a black box.** 451 items and $648M (10% of counted spending) sit under one label. Readers can't see that most of it is the annual nonpublic-school authorization, or how much goes to busing, staffing agencies, or lawyers.
2. **Some category rules invite inference from context instead of text.** "After-school & summer programs" lists "enrichment providers" as an example, so a daytime arts program filed by the department that runs expanded learning gets classified as after-school. 55 of 1,200 After-school items have no after-school, summer or expanded-learning language in their official text. Separately, the same kind of item lands in different places: Measure N/H/G1 spending plans are 248 in Classroom and 82 in Governance; payroll and warrant ratifications are split across Governance (43), Staff & hiring (24) and Food/ops (4). School safety plans (107) sit under "School plans", whose definition only mentions SPSAs.

The fix is a revised codebook (prompt v5), a sub-category field for special education, and a re-summarization of every item so the whole dataset follows one set of rules. Because every published record changes and one category value is renamed, this ships as schema major version 2.

## 2. Scope

**In:**
- Codebook changes in §3, written into `pipeline/prompts/enrich.v5.md`.
- Schema changes in §4 (`packages/consent-schema`), JSON Schema regeneration, CSV export column.
- Pipeline changes in §5: `--all` export, `--replace` import, `category-diff` command, `bySubcategory` totals.
- A full re-run of all 12,071 items through the agent path (Sonnet sub-agents, orchestrated in-session), then re-verification through the API path (§6).
- Documentation (§7): README, RUNBOOK, datapackage field descriptions, site about page.
- Site lockstep change (§4.5): supported schema major, two SCSS keys.

**Out (follow-ons):**
- Sub-category drill-down UI on the site (bars under Special education, sub-filter). This spec only defines the published shape it reads.
- Parsing the NPS/NPA master authorization's attachment names into a vendor list.
- Sub-categories for any category other than Special education.
- Any change to money rules, flags, headline or summary rules.

## 3. Codebook v5

Everything not listed here is unchanged from v4.

### 3.1 General rule, added at the top of the category block

> Classify by what the text says the service or action is, not by the vendor's type or the presenting department.

### 3.2 Category list (13)

| Value | Includes | Doesn't include |
|---|---|---|
| Special education | Nonpublic school and agency contracts, special-ed transport, related services and contract staff for students with IEPs, school psychology interns, special-ed legal, SELPA and special-ed compliance, special-ed grants | General student health |
| Classroom & academic programs | Curriculum, instructional services, teacher training tied to instruction, field trips, college and career pathways, arts/music/sports/mentoring **during the school day** | After-school providers; Measure N/H/G1 plans and budgets (→ Budget, finance & payments) |
| After-school & summer programs | Only when the text places the service outside the school day: after school, before school, expanded learning / ELO-P / ASES / 21st Century, summer, intersession, breaks, Saturday | Daytime enrichment (→ Classroom) |
| Student health, support & family services | Health centers, counseling, translation and interpretation, family engagement, newcomer support | Special-ed services |
| School buildings & construction | Bond projects, design, construction management, inspections, environmental work tied to projects, change orders | Routine maintenance |
| Food, transportation & operations | Nutrition purchasing, activity buses, waste, routine maintenance, furniture and supplies, auctions | Special-ed busing |
| Technology | Software licenses, devices, IT services | Tech bought for a program, when the program is clearer |
| Staff & hiring | Personnel reports, job descriptions, union agreements, recruitment, workforce grants, teacher-residency and fieldwork MOUs | Payroll ratifications (→ Budget, finance & payments) |
| **Legal, compliance & risk** (renamed from "Legal, insurance & risk") | Outside counsel, compliance monitoring and reporting, claims administration, insurance premiums, risk services | Special-ed legal (→ Special education) |
| School plans | Annual per-school plans the Board approves: School Plans for Student Achievement (SPSAs) and school safety plans | — |
| Partnerships & data sharing | No-cost MOUs and data-sharing agreements without a clearer program home | — |
| **Budget, finance & payments** (new) | Budget adoptions and revisions, interim reports, audits, Measure N/H/G1 plans and carryovers, fund transfers, warrant and payroll ratifications, election costs for bond measures | — |
| Governance & board business | Resolutions, board policies, commission items, real property and leases, minutes, appointments, legislative positions | Budget and finance items |

### 3.3 Special education sub-categories (5)

Required when the category is Special education; null otherwise.

| Value | Includes |
|---|---|
| Nonpublic schools & agencies | Annual NPS/NPA master authorizations, individual placements including out-of-state residential, paying or receiving money from another district for a student's placement |
| Transportation | Busing, cabs and other transport to placements and services |
| Services & contract staff | Therapists (speech, OT, PT), nurses and health aides, psychologists and psychiatrists, behavior specialists, mental-health providers, interpreters and ASL, evaluators and assessors; whether a staffing agency or an individual contractor |
| Programs & support | Tutoring and compensatory services, transition and vocational programs, staff training and coaching, intern stipends and fieldwork MOUs, consultants, software and materials |
| Legal, compliance & policy | Attorneys, mediators, due process and settlements, compliance assurances, resolutions, SELPA governance, special-ed grant acceptances and budget items |

Tie-breaks written into the prompt:
- A staffing agency placing therapists, nurses or psychologists for students with IEPs is *Special education → Services & contract staff*, even when presented by Talent.
- Busing for special-education students is *Special education → Transportation*, never Food, transportation & operations.
- Mental-health staff for special-ed students: *Services & contract staff*. District-wide or general-ed mental health: *Student health, support & family services*.

### 3.4 Input and output section

One prompt file serves both paths. A short "Input and output" section says:
- **API mode:** one item per request; the reply is constrained to the JSON schema.
- **Agent mode:** a chunk file (`.cache/enrich/{chunk}.input.json`); write `{chunk}.output.json` as `{ "chunk": …, "items": [ { "file": …, …enrichment } ] }`, then run `npm run consent:enrich-check -- --chunk {chunk}` and fix every error, up to 3 rounds.

Rejected alternative: a shared codebook file composed into two wrappers. One file with two short paragraphs needs no composition code and can't drift.

Both `ENRICH_PROMPT_VERSION` (`pipeline/llm/enrich.ts`) and `AGENT_PROMPT_VERSION` (`pipeline/enrich/agent-io.ts`) become `enrich.v5.md`.

## 4. Schema (`packages/consent-schema`)

### 4.1 Version
`SCHEMA_VERSION` 1.0.0 → **2.0.0**. Renaming an enum value is breaking by the package's own rules.

### 4.2 Enums
- `Category`: rename `'Legal, insurance & risk'` → `'Legal, compliance & risk'`; add `'Budget, finance & payments'`. Order as in §3.2.
- New `SpecialEdSubcategory = z.enum([...])` with the five §3.3 values, exported with `TSpecialEdSubcategory`.

### 4.3 Enrichment
- `Enrichment.subcategory: SpecialEdSubcategory.nullable()`.
- A `superRefine` on `Enrichment`: `category === 'Special education'` ⇒ `subcategory !== null`; otherwise `subcategory === null`. Error path `['subcategory']`, messages "Special education items need a sub-category" / "only Special education items have a sub-category". Because `checkEnrichment` parses with this schema, the API retry loop and the agent `enrich-check` both enforce it.
- `Override.fields.subcategory: SpecialEdSubcategory.nullable()` (inside the existing `.partial()`).
- `ListItem.enrichment` pick adds `subcategory: true`.

### 4.4 Totals
- `Totals.bySubcategory: z.record(z.string(), z.object({ items: z.number(), spending: z.number() }))`. Flat, keyed by sub-category value; only special-education buckets ever appear. Same counting rules as `byCategory` (only `countsTowardTotals` items, excluding the budget/grant-application/payment-ratification flagged items; `spending` is `spendingAmount(money)`, rounded to cents).

### 4.5 Labels and site contract
- `CATEGORY_NOTES`: entries for the renamed and new category per §3.2 (the `Record<TCategory, …>` type makes a missing entry a type error).
- New `SUBCATEGORY_NOTES: Record<TSpecialEdSubcategory, string>` per §3.3.
- `CATEGORY_SLUGS`: `'Legal, compliance & risk': 'legal-compliance-risk'`, `'Budget, finance & payments': 'budget-finance-payments'`.
- Site (`oakvs`), same day, merged before the data push: `SUPPORTED_SCHEMA_MAJOR = 2` in `src/lib/consent/data.ts`; in `src/app/consent-tracker/layout.module.scss` rename the `legal-insurance-risk` key to `legal-compliance-risk` and add a `budget-finance-payments` pair (WCAG AA ≥ 4.5:1 against the background in both themes, like the others). The about page's categories table is generated from `CATEGORY_NOTES`; add a sub-categories table from `SUBCATEGORY_NOTES` and the disclosure paragraph (§7). No other site code hard-codes category strings (checked).

### 4.6 Generated artifacts
- `npm run schema` regenerates `schema/*.json`.
- `pipeline/build/exports.ts`: `subcategory` column after `category` in items CSVs, with description "Special education sub-category (AI classification); empty for other categories." `datapackage.json` picks it up from the column list.

## 5. Pipeline changes

### 5.1 `pipeline/llm/schemas.ts`
`EnrichmentReply.subcategory: SpecialEdSubcategory.nullable()`. Structured outputs can't express the conditional; `checkEnrichment` enforces it and the error goes back to the model.

### 5.2 `pipeline/enrich/agent-io.ts`
- `exportChunks(keys, size, { all })`: with `all`, export every raw item, not just those without a record.
- `importChunks(keys, modelId, { replace })`: with `replace`, overwrite an existing record (today it skips when one exists). Without it, behavior is unchanged.
- Both read the existing `data/enrichments/{key}.json` as plain JSON, not through `EnrichmentsFile`: during the migration those files hold v3 records that fail the v2 schema (old enum value, no sub-category). Only records being written are validated.
- CLI: `enrich-export [--all]`, `enrich-import --model M [--replace]`.

### 5.3 `category-diff` command (new, `pipeline/enrich/category-diff.ts`)
- Input: a snapshot of the previous `data/enrichments/` and the current `data/enrichments/`. `enrich-export --all` copies `data/enrichments/` to `.cache/enrich/previous/` **only if that directory doesn't exist yet**, so repeated pilot iterations keep comparing against the real v3 baseline. Both sides are read as plain JSON (the snapshot can't satisfy the v2 schema).
- Output: `.cache/enrich/category-diff.json` and a console summary:
  - items compared, items whose category changed, from→to matrix (counts and counted spending);
  - sub-category distribution for Special education (items, spending);
  - per-item list of movers: `id`, headline, old category, new category, new sub-category.
- Pure, deterministic, no LLM. Used after the pilot and after the full run; its summary goes into the data commit message and the README note.

### 5.4 `pipeline/build/totals.ts`
Populate `bySubcategory` alongside `byCategory`; round to cents in the same pass.

### 5.5 `pipeline/llm/compare.ts`
Add `['subcategory', e => e.subcategory]` to `FIELDS`.

### 5.6 Unchanged, noted
- Overrides (96) keep winning in the build; none set `category`, so no conflicts. Overrides whose `fields` touch other things still apply to the new records.
- Verification records are invalidated by cache key (`enrichmentCacheKey`), already handled by `pipeline/build/meeting.ts` and re-run by `pipeline/llm/verify.ts`.
- Vendor taxonomy (`topCategory`) recomputes from the new categories; no sub-category tally is added there.

## 6. The run

### 6.1 Preconditions
1. Pause the scheduled run (GitHub Actions cron and any standby). It commits to `main` every 30 minutes; nothing may build or push a half-migrated tree. Target: scheduler back before the Oct 14 agenda posts (by Oct 11, 4 p.m.).
2. Work on branch `codebook-v5`. With v5 strict, the build is red from the schema change until the re-run completes; that is intended.
3. Raise `CONSENT_LLM_MONTHLY_CAP_USD` for October (second readings ≈ $20; default cap is $25 and some has been spent).

### 6.2 Pilot
Meetings: `2026-06-24` (golden fixture; $68M NPS item), `2024-01-10` (mid-era, special-ed heavy), `2021-10-13` (older text style). About 250 items, ~9 chunks.
1. `enrich-export --all --key K` for each; run the agents; `enrich-import --replace --model sonnet-agent`.
2. `category-diff`. Review the matrix and ~30 movers by hand, specifically After-school → Classroom moves and the budget/finance moves, and every special-ed sub-category assignment in `2026-06-24`.
3. Tune the prompt, re-export, re-run until the moves look right. Nothing proceeds to §6.3 until the pilot is clean.

### 6.3 Full run
1. `enrich-export --all` (≈403 chunks of 30, `.cache/enrich/manifest.json`).
2. Swarm, orchestrated in-session with the Workflow tool: pipeline over the manifest at concurrency 8; each sub-agent (Sonnet) reads `enrich.v5.md` and its chunk, writes the output, runs `enrich-check`, fixes errors up to 3 rounds, and reports `{ chunk, passed, errors }`. The script retries a failed chunk once with a fresh agent and returns the ledger. Resumable; outputs persist on disk.
3. Chunks still failing: delete those items' records from `data/enrichments/{key}.json` (an old v3 record is not "stale" by cache key, since the key embeds its own prompt version), then `consent:llm --key K` enriches exactly the missing ones through the API, rather than more agent rounds.
4. `enrich-import --replace --model sonnet-agent` for everything, then `category-diff` over the full set. Spot-check movers in each from→to cell with more than 20 items.

The model label on agent-written records stays `sonnet-agent`, matching the existing convention for records written by Claude Code agents (the exact served model isn't exposed to the agent). README already explains this.

### 6.4 Second readings
Loop `consent:llm --key K` over all 162 meetings. Enrichment is already current (import computed matching cache keys), so this stage only re-verifies: the 20 largest items per meeting plus the usual triggers, through the API with Sonnet. Keeping verification on a different path from the enrichment agents keeps the second reading independent.

### 6.5 Build, verify, publish
1. `consent:build`; `npm test`; `npm run type-check`.
2. Inspect: `totals.byCategory` / `bySubcategory` for a few meetings, `data/exports/items.csv` header and a special-ed row, README generated stats.
3. Merge the site PR (§4.5) first.
4. One data commit on `codebook-v5`: "Re-summarize every item with codebook v5" with the `category-diff` summary in the body; merge to `main`; push; deploy hook; resume the scheduler.

### 6.6 Budget
Enrichment ≈ 40M session tokens (the original backfill: 6.9M for 2,100 items). Second readings ≈ $20 API. Wall clock for the swarm: several hours at concurrency 8; the machine is kept awake for the duration.

## 7. Documentation and disclosure

- **README**, new subsection under "How the data gets made": **"How items are categorized."** Each item gets one of 13 categories, chosen by the AI from the official text alone against a written codebook (link to `pipeline/prompts/enrich.v5.md`), checked in code, correctable by a person via overrides. Special education items also get one of 5 sub-categories. A category means "what the money or action is for", not who presented it. Dated note: in October 2026 every item was re-summarized under prompt v5 when the categories were revised; what changed (budget/finance category added, legal category renamed, after-school rule tightened, special-ed sub-categories) and the headline counts from `category-diff`. Update "What you'll find in each item" to mention the sub-category.
- **RUNBOOK**, new section **"Re-running every summary"**: pause the scheduler, `enrich-export --all`, swarm, `enrich-import --replace`, `category-diff`, re-verify, build, resume; and a **schema major bump checklist**: bump `SCHEMA_VERSION`, `npm run schema`, site `SUPPORTED_SCHEMA_MAJOR`, SCSS keys, merge site first.
- **Site about page**: sub-categories table from `SUBCATEGORY_NOTES`; a one-paragraph version of the re-categorization note.
- **`datapackage.json`**: field description for `subcategory` (via the export column list).
- **CITATION.cff / LICENSE-DATA**: no change.

## 8. Testing

- Schema: `Enrichment` accepts a special-ed item with a sub-category and a non-special-ed item with null; rejects special-ed without one and non-special-ed with one. `Override.fields.subcategory` parses.
- `checkEnrichment`: a special-ed candidate without a sub-category yields a schema error (so both the API retry loop and `enrich-check` surface it).
- `agent-io`: `exportChunks` with `all` includes items that already have records; `importChunks` with `replace` overwrites and without it skips (existing behavior preserved).
- `category-diff`: given two small enrichment sets, produces the expected matrix, movers and sub-category distribution; output is stable across runs.
- `totals`: `bySubcategory` counts and spending on a fixture meeting; excludes flagged budget/payment items the same way `byCategory` does.
- Golden fixture `data/fixtures/golden/2026-06-24/*.json`: regenerated from the pilot output after review, including `subcategory` on special-ed items and the new category values.
- README stats test keeps passing after regeneration.
- `npm run type-check` catches any `Record<TCategory, …>` left incomplete.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Prompt v5 fixes After-school but breaks something else | Pilot on 3 meetings with `category-diff` review before the full run; compare also runs `llm-compare` fields (money, vendor) on the pilot to catch regressions outside categories |
| Scheduler pushes during the migration | Paused first; branch work; one merge at the end |
| Swarm interrupted | Workflow resume; chunk outputs on disk; `--replace` import is idempotent |
| Agent chunks that never pass checks | Fall back to the API path for those items |
| Site deploy fails on schema 2 | Site PR merged before the data push; the version gate fails loudly rather than rendering wrong |
| Oct 14 agenda arrives mid-migration | Scheduler back by Oct 11; if the run slips, the new agenda is enriched under v5 by the normal loop once resumed |
