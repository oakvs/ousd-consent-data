# Category Codebook v5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revise the category codebook (prompt v5), add five special-education sub-categories, bump the data schema to 2.0.0, and re-summarize every one of the 12,071 published items with an in-session agent swarm followed by API second readings.

**Architecture:** The shared zod schema package (`packages/consent-schema`) is the contract between the pipeline and the oakvs site; it gains a renamed and a new category, a nullable `subcategory` with a refinement that ties it to Special education, and `bySubcategory` totals. One prompt file (`enrich.v5.md`) serves both the API path and the agent path. The existing agent I/O (`enrich-export` / `enrich-check` / `enrich-import`) grows `--all` and `--replace` so the swarm can redo items that already have records, and a new pure `category-diff` command reports what moved. The swarm is a Workflow script that pipelines chunks through Sonnet sub-agents, each validating its own output with `enrich-check`.

**Tech Stack:** TypeScript (strict), zod 4.6, vitest, `tsx`, Node `parseArgs`; Claude Code Workflow tool for orchestration; Anthropic API (Sonnet) for second readings.

**Spec:** `docs/superpowers/specs/2026-10-06-category-codebook-v5-design.md`

## Global Constraints

- `SCHEMA_VERSION` becomes exactly `'2.0.0'`; the site's `SUPPORTED_SCHEMA_MAJOR` becomes `2`.
- Category values are display strings and public API. Exact spellings: `'Legal, compliance & risk'`, `'Budget, finance & payments'`. Sub-categories: `'Nonpublic schools & agencies'`, `'Transportation'`, `'Services & contract staff'`, `'Programs & support'`, `'Legal, compliance & policy'`.
- Prompt files are never edited in place: new version = new file (`enrich.v5.md`). Both `ENRICH_PROMPT_VERSION` and `AGENT_PROMPT_VERSION` point at `'enrich.v5.md'`.
- Agent-written records carry `modelId: 'sonnet-agent'`.
- All JSON written through `writeJson` (sorted keys, 2-space indent, trailing newline). Never commit `.cache/`.
- Strict TypeScript: no `any`; explicit return types on exported functions. Imports in the pipeline use relative paths and `@oakvs/consent-schema/*` as the existing files do.
- The scheduled run (`.github/workflows/run.yml` cron + homelab standby) must be paused before Task 6 and resumed only in Task 11. It must be back before Oct 11, 2026, 4 p.m. Oakland time.
- Between Task 1 and the end of Task 9, tests that read committed data (`llm.test.ts` "API reply shape", `build.test.ts` golden/determinism/published contract, `exports.test.ts`, `readme.test.ts`) are expected to fail. Run unit tests by file until then; the full suite must be green at the end of Task 9.

## Review Focus

1. A special-education item with `subcategory: null` arriving from either path must be rejected with a message naming `subcategory` — test in Task 1 (schema) and Task 2 (`checkEnrichment`).
2. A non-special-education item carrying a sub-category must be rejected, so the field can't leak onto other categories — test in Task 1.
3. `enrich-import` without `--replace` must keep today's skip-if-exists behavior exactly, so the normal pipeline path is unchanged — test in Task 3.
4. `category-diff` must not crash on records written under the old schema (old enum value, no `subcategory`), since that is exactly what it compares against — test in Task 4.
5. `bySubcategory` must apply the same counting exclusions as `byCategory` (flagged budget/payment items and non-counting items don't add spending) — test in Task 5.

---

### Task 1: Schema 2.0.0 — enums, sub-category, totals, labels, raw migration

**Files:**
- Modify: `packages/consent-schema/src/schema.ts:17-35` (version, `Category`), `:109-134` (`Enrichment`), `:228-241` (`Override`), `:442` (`Totals`), `:498-510` (`ListItem` pick)
- Modify: `packages/consent-schema/src/labels.ts:3-55` (`CATEGORY_NOTES`), `:211-224` (`CATEGORY_SLUGS`)
- Modify: `pipeline/__tests__/helpers.ts:9-33` (`makeEnrichment`)
- Create: `packages/consent-schema/src/schema.test.ts`
- Modify: `data/raw/*.json` (`schemaVersion` only, via script)
- Regenerate: `schema/*.schema.json`

**Interfaces:**
- Produces: `SpecialEdSubcategory` (zod enum), `TSpecialEdSubcategory`; `EnrichmentFields` (the unrefined object, for `.shape`/`.pick`), `Enrichment` (refined); `TEnrichment.subcategory: TSpecialEdSubcategory | null`; `TTotals.bySubcategory: Record<string, { items: number; spending: number }>`; `SUBCATEGORY_NOTES: Record<TSpecialEdSubcategory, string>`.

- [ ] **Step 1: Write the failing schema tests**

Create `packages/consent-schema/src/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { CATEGORY_NOTES, CATEGORY_SLUGS, SUBCATEGORY_NOTES } from './labels'
import { Category, Enrichment, Override, SCHEMA_VERSION, SpecialEdSubcategory, Totals } from './schema'

const base = {
  headline: 'Pays Zum up to $50,000 for special education busing',
  summary: 'Zum will bus students with disabilities to their placements.',
  category: 'Special education',
  subcategory: 'Transportation',
  actionType: 'new_agreement',
  vendor: { name: 'Zum', location: null, kind: 'organization' },
  schools: [],
  money: {
    direction: 'expense',
    amountType: 'not_to_exceed',
    thisAction: 50_000,
    thisActionRange: null,
    priorTotal: null,
    newTotal: null,
    byYear: {},
    evidence: 'not to exceed $50,000.00',
  },
  term: { start: null, end: null, addedStart: null },
  flags: [],
  sourceIssueCandidate: null,
  uncertain: [],
}

describe('schema 2.0.0 codebook', () => {
  it('is version 2.0.0', () => {
    expect(SCHEMA_VERSION).toBe('2.0.0')
  })

  it('has 13 categories with the renamed and new values', () => {
    expect(Category.options).toHaveLength(13)
    expect(Category.options).toContain('Legal, compliance & risk')
    expect(Category.options).toContain('Budget, finance & payments')
    expect(Category.options).not.toContain('Legal, insurance & risk')
  })

  it('has five special education sub-categories', () => {
    expect(SpecialEdSubcategory.options).toEqual([
      'Nonpublic schools & agencies',
      'Transportation',
      'Services & contract staff',
      'Programs & support',
      'Legal, compliance & policy',
    ])
  })

  it('labels every category and sub-category', () => {
    for (const c of Category.options) {
      expect(CATEGORY_NOTES[c].includes.length).toBeGreaterThan(10)
      expect(CATEGORY_SLUGS[c]).toMatch(/^[a-z-]+$/)
    }
    for (const s of SpecialEdSubcategory.options) expect(SUBCATEGORY_NOTES[s].length).toBeGreaterThan(10)
    expect(CATEGORY_SLUGS['Legal, compliance & risk']).toBe('legal-compliance-risk')
    expect(CATEGORY_SLUGS['Budget, finance & payments']).toBe('budget-finance-payments')
  })
})

describe('sub-category refinement', () => {
  it('accepts a special education item with a sub-category', () => {
    expect(Enrichment.safeParse(base).success).toBe(true)
  })

  it('accepts another category with a null sub-category', () => {
    expect(Enrichment.safeParse({ ...base, category: 'Technology', subcategory: null }).success).toBe(true)
  })

  it('rejects a special education item without a sub-category, naming the field', () => {
    const r = Enrichment.safeParse({ ...base, subcategory: null })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(['subcategory'])
      expect(r.error.issues[0].message).toBe('Special education items need a sub-category')
    }
  })

  it('rejects a sub-category on any other category', () => {
    const r = Enrichment.safeParse({ ...base, category: 'Technology' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('only Special education items have a sub-category')
  })

  it('lets an override set the sub-category', () => {
    const r = Override.safeParse({ fields: { subcategory: 'Programs & support' }, reviewer: null, reviewedAt: null, note: null })
    expect(r.success).toBe(true)
  })

  it('totals carry bySubcategory', () => {
    const r = Totals.safeParse({
      items: 0, enrichedItems: 0, spendingTotal: 0, spendingItems: 0, yearlyCapsTotal: 0, yearlyCapItems: 0,
      revenueTotal: 0, revenueItems: 0, decreaseTotal: 0, paymentsRatifiedTotal: 0, paymentsRatifiedItems: 0,
      budgetAllocatedTotal: 0, budgetAllocatedItems: 0, appliedForTotal: 0, appliedForItems: 0,
      flagCounts: {}, byCategory: {}, bySubcategory: { Transportation: { items: 1, spending: 50_000 } },
    })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/consent-schema/src/schema.test.ts`
Expected: FAIL — `SUBCATEGORY_NOTES`/`SpecialEdSubcategory` not exported; version is `1.0.0`.

- [ ] **Step 3: Change `schema.ts`**

Version and `Category` (replace lines 17–35):

```ts
export const SCHEMA_VERSION = '2.0.0'

// ─── Codebook ────────────────────────────────────────────────────────────────

export const Category = z.enum([
  'Special education',
  'Classroom & academic programs',
  'After-school & summer programs',
  'Student health, support & family services',
  'School buildings & construction',
  'Food, transportation & operations',
  'Technology',
  'Staff & hiring',
  'Legal, compliance & risk',
  'School plans',
  'Partnerships & data sharing',
  'Budget, finance & payments',
  'Governance & board business',
])
export type TCategory = z.infer<typeof Category>

/** Second level for Special education only; `null` on every other category. */
export const SpecialEdSubcategory = z.enum([
  'Nonpublic schools & agencies',
  'Transportation',
  'Services & contract staff',
  'Programs & support',
  'Legal, compliance & policy',
])
export type TSpecialEdSubcategory = z.infer<typeof SpecialEdSubcategory>
```

`Enrichment` (replace lines 109–134). The unrefined object keeps a name so `Override` and `ListItem` can use `.shape` and `.pick`:

```ts
/** The enrichment's fields. Use `Enrichment` to parse; this is for `.shape` and `.pick`. */
export const EnrichmentFields = z.object({
  headline: z.string().max(140),
  summary: z.string().max(900),
  category: Category,
  /** Required when `category` is Special education, null otherwise (enforced by `Enrichment`). */
  subcategory: SpecialEdSubcategory.nullable(),
  actionType: ActionType,
  vendor: z.object({
    name: z.string().nullable(),
    location: z.string().nullable(),
    /** Individuals' names stay out of headlines (§15); organizations are always named. */
    kind: z.enum(['individual', 'organization']).nullable().default(null),
  }),
  schools: z.array(z.string()),
  money: Money,
  term: z.object({
    start: IsoDate.nullable(),
    end: IsoDate.nullable(),
    /** For amendments/extensions: when the newly added period starts, if stated. Drives `after_work_began`. */
    addedStart: IsoDate.nullable().default(null),
  }),
  flags: z.array(LlmFlag),
  /** LLM-noticed inconsistency; needs a human to confirm before it's public. */
  sourceIssueCandidate: z.string().nullable(),
  uncertain: z.array(z.string()),
})

export const Enrichment = EnrichmentFields.superRefine((e, ctx) => {
  if (e.category === 'Special education' && e.subcategory === null) {
    ctx.addIssue({ code: 'custom', path: ['subcategory'], message: 'Special education items need a sub-category' })
  }
  if (e.category !== 'Special education' && e.subcategory !== null) {
    ctx.addIssue({ code: 'custom', path: ['subcategory'], message: 'only Special education items have a sub-category' })
  }
})
export type TEnrichment = z.infer<typeof Enrichment>
```

`Override.fields` (lines 229–241): add `subcategory` and switch the two `Enrichment.shape` references:

```ts
  fields: z
    .object({
      headline: z.string(),
      summary: z.string(),
      category: Category,
      subcategory: SpecialEdSubcategory.nullable(),
      actionType: ActionType,
      vendor: EnrichmentFields.shape.vendor,
      schools: z.array(z.string()),
      money: Money.partial(),
      term: EnrichmentFields.shape.term,
      flags: z.array(LlmFlag),
    })
    .partial(),
```

`Totals` (after line 442):

```ts
  byCategory: z.record(z.string(), z.object({ items: z.number(), spending: z.number() })),
  /** Special education sub-categories only; same counting rules as byCategory. */
  bySubcategory: z.record(z.string(), z.object({ items: z.number(), spending: z.number() })),
```

`ListItem` (the `enrichment: Enrichment.pick({...})` block around line 498):

```ts
  enrichment: EnrichmentFields.pick({
    headline: true,
    summary: true,
    category: true,
    subcategory: true,
    actionType: true,
    vendor: true,
    schools: true,
  }).extend({
```

- [ ] **Step 4: Change `labels.ts`**

Replace the `'Legal, insurance & risk'`, `'After-school & summer programs'`, `'Classroom & academic programs'`, `'School plans'`, `'Staff & hiring'`, `'Governance & board business'` and `'Special education'` entries of `CATEGORY_NOTES`, and add the new category, so the map reads:

```ts
export const CATEGORY_NOTES: Record<TCategory, { includes: string; excludes: string | null }> = {
  'Special education': {
    includes: 'Nonpublic school and agency contracts, special-ed transport, related services and contract staff for students with IEPs, school psychology interns, special-ed legal, SELPA and special-ed compliance, special-ed grants',
    excludes: 'General student health',
  },
  'Classroom & academic programs': {
    includes: 'Curriculum, instructional services, teacher training tied to instruction, field trips, college and career pathways, arts, music, sports and mentoring during the school day',
    excludes: 'After-school providers; Measure N, H and G1 plans and budgets (Budget, finance & payments)',
  },
  'After-school & summer programs': {
    includes: 'Programs the text places outside the school day: after school, before school, expanded learning (ELO-P, ASES, 21st Century), summer, intersession, breaks, Saturdays',
    excludes: 'Daytime enrichment (Classroom & academic programs)',
  },
  'Student health, support & family services': {
    includes: 'Health centers, counseling, translation and interpretation, family engagement, newcomer support',
    excludes: 'Special-ed services',
  },
  'School buildings & construction': {
    includes: 'Bond projects, design, construction management, inspections, environmental work tied to projects, change orders',
    excludes: 'Routine maintenance contracts',
  },
  'Food, transportation & operations': {
    includes: 'Nutrition purchasing, activity buses, waste, routine maintenance, furniture and supplies, auctions',
    excludes: 'Special-ed busing',
  },
  Technology: {
    includes: 'Software licenses, devices, IT services',
    excludes: 'Tech purchased for a program, when the program is clearer',
  },
  'Staff & hiring': {
    includes: 'Personnel reports, job descriptions, union agreements, recruitment, workforce grants, teacher-residency and fieldwork partnerships',
    excludes: 'Payroll ratifications (Budget, finance & payments)',
  },
  'Legal, compliance & risk': {
    includes: 'Outside counsel, compliance monitoring and reporting, claims administration, insurance premiums, risk services',
    excludes: 'Special-ed legal (goes to Special education)',
  },
  'School plans': {
    includes: 'Annual per-school plans the Board approves: School Plans for Student Achievement (SPSAs) and school safety plans',
    excludes: null,
  },
  'Partnerships & data sharing': {
    includes: 'No-cost agreements and data-sharing agreements without a clearer program home',
    excludes: null,
  },
  'Budget, finance & payments': {
    includes: 'Budget adoptions and revisions, interim reports, audits, Measure N, H and G1 plans and carryovers, fund transfers, warrant and payroll ratifications, election costs for bond measures',
    excludes: null,
  },
  'Governance & board business': {
    includes: 'Resolutions, board policies, commission items, real property and leases, minutes, appointments, legislative positions',
    excludes: 'Budget and finance items',
  },
}

/** Plain-English scope of each Special education sub-category, shown on the about page. */
export const SUBCATEGORY_NOTES: Record<TSpecialEdSubcategory, string> = {
  'Nonpublic schools & agencies':
    'Annual nonpublic school and agency master authorizations, individual placements including out-of-state residential schools, and paying or receiving money from another district for a student\'s placement',
  Transportation: 'Busing, cabs and other transport to placements and services',
  'Services & contract staff':
    'Therapists (speech, occupational, physical), nurses and health aides, psychologists and psychiatrists, behavior specialists, mental-health providers, interpreters and ASL, evaluators and assessors, whether a staffing agency or an individual contractor',
  'Programs & support':
    'Tutoring and compensatory services, transition and vocational programs, staff training and coaching, intern stipends and fieldwork agreements, consultants, software and materials',
  'Legal, compliance & policy':
    'Attorneys, mediators, due process and settlements, compliance assurances, resolutions, SELPA governance, special-ed grant acceptances and budget items',
}
```

Add `TSpecialEdSubcategory` to the type import at line 1. In `CATEGORY_SLUGS`, replace the legal line and add the new one:

```ts
  'Legal, compliance & risk': 'legal-compliance-risk',
  'Budget, finance & payments': 'budget-finance-payments',
```

- [ ] **Step 5: Update the test helper**

In `pipeline/__tests__/helpers.ts`, `makeEnrichment`'s defaults: add `subcategory: null,` directly after `category: 'Classroom & academic programs',`.

- [ ] **Step 6: Run the schema tests and type-check**

Run: `npx vitest run packages/consent-schema/src/schema.test.ts && npm run type-check`
Expected: schema tests PASS. Type-check will list errors in pipeline files that construct enrichments or totals without the new fields (`pipeline/build/totals.ts`, `pipeline/llm/schemas.ts`, possibly `pipeline/llm/compare.ts`); note them, they are fixed in Tasks 2 and 5. If type-check reports anything in `packages/consent-schema`, fix it now.

- [ ] **Step 7: Regenerate the JSON Schemas**

Run: `npm run schema`
Expected: `wrote 13 schema file(s) → schema/`. Then `git diff --stat schema/` shows the enum changes and the new `subcategory` and `bySubcategory` properties. If `z.toJSONSchema` throws on the refinement, generate from `EnrichmentFields` instead: in `packages/consent-schema/src/json-schema.ts`, the `EnrichmentsFile` entry stays as is (the refinement is a check, not a type, and is dropped from JSON Schema); only change this if the command actually fails.

- [ ] **Step 8: Migrate the raw snapshots' version string**

`RawSnapshot.schemaVersion` is `z.literal(SCHEMA_VERSION)`, so every file in `data/raw/` must say `2.0.0` or nothing can read it. One-off, keeps the stable formatting:

```bash
npx tsx -e "
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJson } from './pipeline/store'
const dir = path.join(process.cwd(), 'data', 'raw')
let n = 0
for (const f of (await readdir(dir)).filter(f => f.endsWith('.json'))) {
  const j = JSON.parse(await readFile(path.join(dir, f), 'utf8'))
  if (j.schemaVersion === '2.0.0') continue
  j.schemaVersion = '2.0.0'
  await writeJson(path.join(dir, f), j)
  n++
}
console.log('migrated', n, 'raw snapshots')
"
```

Expected: `migrated 162 raw snapshots`; `git diff --stat data/raw | tail -1` shows 162 files, 1 insertion and 1 deletion each.

- [ ] **Step 9: Commit**

```bash
git add packages/consent-schema pipeline/__tests__/helpers.ts schema data/raw
git commit -m "Schema 2.0.0: Budget, finance & payments; Legal, compliance & risk; special-ed sub-categories

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Prompt v5 and the reply schema

**Files:**
- Create: `pipeline/prompts/enrich.v5.md`
- Modify: `pipeline/llm/enrich.ts:21`, `pipeline/enrich/agent-io.ts:21`, `pipeline/llm/schemas.ts:13,19-23`, `pipeline/llm/compare.ts:21`
- Test: `pipeline/__tests__/validate.test.ts` (append)

**Interfaces:**
- Consumes: `SpecialEdSubcategory` from Task 1.
- Produces: `ENRICH_PROMPT_VERSION === AGENT_PROMPT_VERSION === 'enrich.v5.md'`; `EnrichmentReply.subcategory`.

- [ ] **Step 1: Write the failing `checkEnrichment` test**

Append to `pipeline/__tests__/validate.test.ts`:

```ts
describe('checkEnrichment and the sub-category rule', () => {
  it('rejects a special education item without a sub-category, from either path', async () => {
    const { checkEnrichment } = await import('../enrich/agent-io')
    const text = 'Approval of an agreement with Zum, in an amount not to exceed $100,000.00, for special education busing.'
    const bad = makeEnrichment({ category: 'Special education', subcategory: null })
    const problems = checkEnrichment(text, bad).problems
    expect(problems.some(p => p.severity === 'error' && p.message.includes('subcategory'))).toBe(true)
    const good = makeEnrichment({ category: 'Special education', subcategory: 'Transportation' })
    expect(checkEnrichment(text, good).problems.filter(p => p.severity === 'error')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run pipeline/__tests__/validate.test.ts -t "sub-category rule"`
Expected: PASS already for the rejection half (the schema from Task 1 does it) but the file may not compile until `schemas.ts` is fixed; if it FAILS with a type error in `pipeline/llm/schemas.ts`, that's the signal for Step 3.

- [ ] **Step 3: Update the reply schema, prompt versions and compare fields**

`pipeline/llm/schemas.ts`: import and field —

```ts
import { ActionType, Category, IssueTopic, IssueVerdict, LlmFlag, ProfileField, SpecialEdSubcategory } from '@oakvs/consent-schema/schema'
```

```ts
export const EnrichmentReply = z.object({
  headline: z.string(),
  summary: z.string(),
  category: Category,
  subcategory: SpecialEdSubcategory.nullable(),
  actionType: ActionType,
```

`pipeline/llm/enrich.ts:21`: `export const ENRICH_PROMPT_VERSION = 'enrich.v5.md'`
`pipeline/enrich/agent-io.ts:21`: `export const AGENT_PROMPT_VERSION = 'enrich.v5.md'`
`pipeline/llm/compare.ts`, in `FIELDS` after the `category` line: `['subcategory', e => e.subcategory],`

- [ ] **Step 4: Write `pipeline/prompts/enrich.v5.md`**

```markdown
# Task: turn an OUSD Board consent item into structured, plain-English JSON (prompt v5)

<!-- v5 = the v4 codebook with a revised category list (13 categories; Budget, finance & payments added; Legal, compliance & risk renamed), a tightened after-school rule, a rule against inferring from vendor type or department, and a sub-category for Special education. Serves both the API (one item per request) and Claude Code agents (one chunk file per agent). -->

You are enriching items from the Oakland Unified School District (OUSD) Board of Education "General Consent Report" for a public transparency tool. Readers are parents, reporters and board members who are not finance or legal experts. They most want to know: what is this, who gets paid, how much, for what, and is there anything unusual about how it was approved.

## Input and output

Each item is JSON with `file`, `agendaNumber`, `title` (official short title), `text` (official full action text — **THE ONLY SOURCE OF TRUTH**), `matterType`, `presenter`, `group` and `fundingSource`.

- **API mode:** each request gives you one item as `{ meetingKey, meetingDate, item }`. Reply with one JSON object for that item; the reply is constrained to a JSON schema, so the shape is fixed and these rules decide the values. `byYear` is a list of `{ "year", "amount" }`.
- **Agent mode:** you are given a chunk file `.cache/enrich/{chunk}.input.json` with `{ chunk, meetingKey, meetingDate, items }`. Write `.cache/enrich/{chunk}.output.json` as `{ "chunk": "...", "items": [ { "file": "<the item's file>", ...the fields below } ] }`, one entry per input item in input order, then run `npm run consent:enrich-check -- --chunk {chunk}` and fix every error, up to 3 rounds. `byYear` is an object keyed by year label, e.g. `{"2026-27": 323511.63}`, or `{}`.

The fields, in either mode:

```json
{
  "headline": "string",
  "summary": "string",
  "category": "one of the CATEGORY values",
  "subcategory": "one of the SUB-CATEGORY values when category is Special education; otherwise null",
  "actionType": "one of the ACTION TYPE values",
  "vendor": { "name": "string or null", "location": "string or null", "kind": "individual | organization | null" },
  "schools": ["school names, only if the item names specific schools or sites; else []"],
  "money": {
    "direction": "expense | revenue | decrease | no_cost",
    "amountType": "not_to_exceed | fixed | cumulative | per_year | sales_cap | null",
    "thisAction": 1234.56,
    "thisActionRange": null,
    "priorTotal": null,
    "newTotal": null,
    "byYear": "see Input and output",
    "evidence": "exact substring copied from text containing the thisAction figure"
  },
  "term": { "start": "YYYY-MM-DD or null", "end": "YYYY-MM-DD or null", "addedStart": "YYYY-MM-DD or null" },
  "flags": [],
  "sourceIssueCandidate": null,
  "uncertain": []
}
```

## Field rules

**headline**: at most 110 characters (hard limit 140). Plain English. Start with a verb or a clear noun phrase. Include the dollar amount if there is one, and the vendor or partner by its common name. Example: "Adds $1.02M to keep Frontline's staff absence, evaluation and training software through 2029".
- Set `vendor.kind` to `"individual"` when the contracting party is a natural person in their own name (judge from the text, not the name's shape), `"organization"` for companies, nonprofits, agencies and anyone contracting through an LLC/Inc./dba, or `null` when there's no vendor.
- Always name organizations. Don't put individual people's names in headlines when the role says enough ("Pays a school psychology intern up to $30,000…"). Names can stay in the official text.
- Use neutral language, with no adjectives like "huge", "controversial" or "wasteful".

**summary**: 2–3 short sentences at about an 8th-grade reading level (hard limit 900 characters).
- Say what the money actually buys or what the agreement does, who benefits (which students, schools or departments), and the time period.
- If it's an amendment, say what changed: more money, more time, or more scope.
- If the district is buying without its own competitive bid, say so plainly in one neutral clause (e.g. "The district is buying through another agency's existing contract instead of running its own bid.").
- If the work started before approval, say so neutrally.
- Don't speculate beyond the text, and don't editorialize.

**No jargon.** In the headline and summary, never use these without spelling them out the first time, e.g. "California Multiple Award Schedules (CMAS)":
- CMAS, Graydon (say "a legal exception to public bidding (called the Graydon exception)")
- LLB (lease-leaseback)
- SPSA (School Plan for Student Achievement)
- MOU (memorandum of understanding)
- NPS/NPA (nonpublic school/agency)
- PCO (preliminary change order)
- IEP (Individualized Education Program)
- DSA (Division of the State Architect, or data-sharing agreement: whichever the text means)

**category**: pick the single best fit for what the item is FOR. **Classify by what the text says the service or action is, not by the vendor's type or the presenting department.** An arts nonprofit teaching during the school day is Classroom & academic programs even if the expanded-learning office filed it; a staffing agency placing therapists for students with IEPs is Special education even if Talent filed it.
- "Special education": nonpublic school/agency contracts, special-ed transport, related services and contract staff for students with IEPs, school psychology interns, special-ed legal, SELPA and special-ed compliance, special-ed grants
- "Classroom & academic programs": curriculum, instruction, teacher training tied to instruction, field trips, college and career pathways; arts, music, sports and mentoring during the school day
- "After-school & summer programs": ONLY when the text itself places the program outside the school day: after school, before school, expanded learning / ELO-P / ASES / 21st Century, summer, intersession, winter or spring break, Saturday. If the text doesn't say so, it isn't this category.
- "Student health, support & family services": health centers, counseling, translation, family engagement, newcomer support
- "School buildings & construction": bond projects, design, construction management, inspections, environmental work for projects, change orders
- "Food, transportation & operations": nutrition purchasing, activity buses, waste, routine maintenance, furniture, supplies, auctions (special-ed busing goes to Special education)
- "Technology": software licenses, devices, IT services (unless bought for a program that's clearer)
- "Staff & hiring": personnel reports, job descriptions, union agreements, recruitment, workforce grants, teacher-residency and fieldwork MOUs (payroll ratifications go to Budget, finance & payments)
- "Legal, compliance & risk": outside counsel, compliance monitoring and reporting, claims administration, insurance premiums, risk services (special-ed legal goes to Special education)
- "School plans": annual per-school plans the Board approves: School Plans for Student Achievement and school safety plans
- "Partnerships & data sharing": only for no-cost MOUs or data-sharing agreements whose purpose doesn't fit a program category better
- "Budget, finance & payments": budget adoptions and revisions, interim reports, audits, Measure N / H / G1 plans and carryovers, fund transfers, warrant and payroll ratifications, election costs for bond measures
- "Governance & board business": resolutions, board policies, commission items, real property and leases, minutes, appointments, legislative positions (budget and finance items go to Budget, finance & payments)

**subcategory**: when `category` is "Special education", pick exactly one; otherwise `null`.
- "Nonpublic schools & agencies": the annual nonpublic school/agency master authorization, individual placements including out-of-state residential schools, paying or receiving money from another district for a student's placement
- "Transportation": busing, cabs and other transport to placements and services
- "Services & contract staff": therapists (speech, occupational, physical), nurses and health aides, psychologists and psychiatrists, behavior specialists, mental-health providers, interpreters and ASL, evaluators and assessors; whether through a staffing agency or an individual contractor
- "Programs & support": tutoring and compensatory services, transition and vocational programs, staff training and coaching, intern stipends and fieldwork MOUs, consultants, software and materials
- "Legal, compliance & policy": attorneys, mediators, due process and settlements, compliance assurances, resolutions, SELPA governance, special-ed grant acceptances and budget items

Tie-breaks:
- A staffing agency placing therapists, nurses or psychologists for students with IEPs: "Services & contract staff", even when presented by Talent.
- Busing for special-education students: "Special education" → "Transportation", never Food, transportation & operations.
- Mental-health staff serving special-education students: "Services & contract staff". District-wide or general-education mental health: Student health, support & family services.

**actionType**: one of these values:
- "new_agreement"
- "amendment"
- "change_order"
- "bid_award"
- "cooperative_purchase" (piggyback, CMAS, or another agency's contract)
- "mou_or_data_sharing"
- "grant_or_funding_in"
- "school_plan"
- "personnel"
- "resolution_or_policy"
- "termination"
- "other"

## Money rules (these matter most)

1. **Only use dollar figures that literally appear in `text`.** Never compute, add, round or infer. Numbers must be JSON numbers (no `$` or commas). If a figure isn't stated, use `null`.
2. **`thisAction`** is the amount this specific vote adds, authorizes or receives.
   - For amendments, it's the ADDED amount, not the new total.
   - For decreases, it's the positive reduction, with `direction: "decrease"`.
   - For grants and funding coming in, use `direction: "revenue"`.
   - If the item says $0 or no cost: `direction: "no_cost"`, `thisAction: null`.
3. **`priorTotal` / `newTotal`**: fill these only when the text states them (e.g. "increasing … from $X to $Y").
   - **If an amendment states only the new overall (cumulative) total and not the added amount, set `thisAction: null`.** Put that total in `newTotal`, and any stated earlier total in `priorTotal`. Never put a contract's overall total in `thisAction` for an amendment: it would count the whole contract as new spending.
   - Year-by-year figures go in `byYear`, not in `thisAction`.
4. **Yearly limits.** If the amount is a limit per year ("per year", "annual", "each fiscal year", "per contract year", "in a fiscal year"), use `amountType: "per_year"`.
   - If a yearly range is given ("between $13,083,445 and $17,608,594 per year"), set `thisActionRange: [low, high]` and put the HIGH figure in `thisAction`.
   - Otherwise `thisActionRange` is `null`.
5. **Auction or sales caps** (money the district may *receive* from sales, not spend): `direction: "no_cost"`, `amountType: "sales_cap"`, `thisAction: null`.
6. **`byYear`**: fill this only if the text breaks the amount down by year (see Input and output for the shape in your mode). Otherwise empty.
7. **Several vendors or amounts in one item**: use the total if the text states one. Otherwise use the largest single stated amount, name the others in the summary, and add `"money"` to `uncertain`.
8. **$0 master agreements** (task orders to follow): `direction: "no_cost"`, and the summary says future task orders will come back separately.
9. **`evidence`**: copy EXACTLY, character for character (spacing, punctuation, typos and all), a short substring of `text` (≤ 200 characters) that contains the `thisAction` figure. Use `null` if `thisAction` is null.

## Term

- `start` / `end`: the agreement's or service period's dates, if stated. Convert "July 1, 2026" → "2026-07-01". A school year like "2026-2027" with no dates → start "2026-07-01", end "2027-06-30".
- `addedStart`: for amendments and extensions, the date the NEWLY ADDED period starts, if stated (e.g. "extending the term from June 30, 2026 to June 30, 2041" → "2026-07-01"). Otherwise `null`.

## Flags

Include every one that applies, based only on the text:
- "no_competitive_bid": piggyback, cooperative purchase, CMAS, Graydon exception, sole source, a "best interest of the District" finding to forgo bidding, or an emergency contract
- "multi_year": the term spans more than one school year (more than ~13 months)
- "time_extension_only": the change only extends time, with no added money
- "emergency": the text describes emergency work or contracting

Don't add any other flags. "After work began", "raises existing contract", "delayed at an earlier meeting" and similar flags are computed in code.

## sourceIssueCandidate and uncertain

- **`sourceIssueCandidate`**: if the text's own numbers don't add up (prior + added ≠ new), the title contradicts the action text, an amount looks misprinted (e.g. "$8,639.911.00"), or the item looks like a duplicate, describe it in one neutral sentence. Otherwise `null`. A human will confirm it before it's published.
- **`uncertain`**: list the field names you're unsure about (e.g. `["money", "category"]`), or `[]`.

## Process

1. Work through each item carefully. Accuracy matters more than speed: this will be published.
2. Your output is checked in code: the schema (including that Special education items have a sub-category and no other item does), every `evidence` an exact substring of `text`, and every amount present in `text`. If a check fails, you get the errors back; fix every one and try again. If an amount truly appears in the text in an unusual form (e.g. a misprint), keep the figure and explain it in `sourceIssueCandidate`.
```

- [ ] **Step 5: Run the validate tests and type-check**

Run: `npx vitest run pipeline/__tests__/validate.test.ts && npm run type-check`
Expected: validate tests PASS. Type-check may still report `pipeline/build/totals.ts` (missing `bySubcategory`) — fixed in Task 5; nothing else.

- [ ] **Step 6: Commit**

```bash
git add pipeline/prompts/enrich.v5.md pipeline/llm/enrich.ts pipeline/enrich/agent-io.ts pipeline/llm/schemas.ts pipeline/llm/compare.ts pipeline/__tests__/validate.test.ts
git commit -m "Prompt enrich.v5: revised categories, special-ed sub-categories, one file for both paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `enrich-export --all` and `enrich-import --replace`

**Files:**
- Modify: `pipeline/store.ts:71-79` (add `readJsonLoose`)
- Modify: `pipeline/enrich/agent-io.ts:11-60,138-180`
- Modify: `pipeline/cli.ts:25-27` (help), `:82-114` (`parseArgs` options), `:348-369` (cases)
- Modify: `RUNBOOK.md:76-93` (commands)
- Create: `pipeline/__tests__/agent-io.test.ts`

**Interfaces:**
- Produces: `readJsonLoose<T>(file: string): Promise<T | null>` in `store.ts`; `enrichDir(): string`, `previousDir(): string` in `agent-io.ts`; `exportChunks(keys: string[] | null, size: number, opts?: { all?: boolean })`; `importChunks(keys: string[] | null, modelId: string, opts?: { replace?: boolean })`; type `TLooseEnrichmentsFile`.
- Env: `CONSENT_ENRICH_DIR` overrides `.cache/enrich` (tests use it).

- [ ] **Step 1: Write the failing tests**

Create `pipeline/__tests__/agent-io.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SCHEMA_VERSION } from '@oakvs/consent-schema/schema'
import type { TRawItem, TRawSnapshot } from '@oakvs/consent-schema/schema'

import { exportChunks, importChunks, outputPath, previousDir } from '../enrich/agent-io'
import { getDataRoot, paths, readJsonLoose, setDataRoot, writeJson } from '../store'

import { makeEnrichment } from './helpers'

import type { TLooseEnrichmentsFile } from '../enrich/agent-io'

const REAL = getDataRoot()
const KEY = '2026-01-14'
const TEXT_A = 'Approval of an agreement with Acme, in an amount not to exceed $100,000.00, for tutoring.'
const TEXT_B = 'Approval of an agreement with Zum, in an amount not to exceed $50,000.00, for special education busing.'
let tmp: string

const rawItem = (file: string, title: string, text: string): TRawItem => ({
  agendaNumber: 'R.-1', agendaSequence: 1, consentSection: 'general', group: 'Chief Academic Officer', file, matterId: 1,
  matterGuid: null, title, text, matterType: 'Agreement or Contract', presenter: null, vendorNo: null, resourceSite: null,
  fundingSource: null, introDate: null, attachments: [], history: [],
})

/** A record written under the old codebook: an enum value v2 no longer has, and no sub-category. */
const OLD_RECORD = {
  modelId: 'sonnet-agent',
  promptVersion: 'enrich.v3.md',
  cacheKey: 'old',
  output: { ...makeEnrichment(), category: 'Legal, insurance & risk', subcategory: undefined },
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'agent-io-'))
  setDataRoot(path.join(tmp, 'data'))
  process.env.CONSENT_ENRICH_DIR = path.join(tmp, 'enrich')
  const snapshot: TRawSnapshot = {
    schemaVersion: SCHEMA_VERSION, meetingKey: KEY, eventId: null, fetchedAt: '2026-01-14T00:00:00Z', source: 'legistar', consentVotes: [],
    items: [rawItem('26-0001', 'Acme tutoring', TEXT_A), rawItem('26-0002', 'Zum busing', TEXT_B)],
  }
  await writeJson(paths.raw(KEY), snapshot)
  await writeJson(paths.enrichments(KEY), { meetingKey: KEY, items: { '26-0001': OLD_RECORD } })
})

afterEach(async () => {
  setDataRoot(REAL)
  delete process.env.CONSENT_ENRICH_DIR
  await rm(tmp, { recursive: true, force: true })
})

const writeOutput = async (chunk: string, items: Record<string, unknown>[]): Promise<void> =>
  writeFile(outputPath(chunk), JSON.stringify({ chunk, items }))

const newA = { file: '26-0001', ...makeEnrichment({ money: { evidence: 'not to exceed $100,000.00' } }) }
const newB = {
  file: '26-0002',
  ...makeEnrichment({
    headline: 'Pays Zum up to $50,000 for special education busing',
    category: 'Special education',
    subcategory: 'Transportation',
    vendor: { name: 'Zum', location: null, kind: 'organization' },
    money: { thisAction: 50_000, evidence: 'not to exceed $50,000.00' },
  }),
}

describe('enrich-export', () => {
  it('exports only items without a record by default', async () => {
    const manifest = await exportChunks([KEY], 30)
    expect(manifest).toHaveLength(1)
    expect(manifest[0].items).toBe(1)
    const input = JSON.parse(await readFile(manifest[0].input, 'utf8')) as { items: { file: string }[] }
    expect(input.items.map(i => i.file)).toEqual(['26-0002'])
  })

  it('with all, exports every item and snapshots the previous enrichments once', async () => {
    const manifest = await exportChunks([KEY], 30, { all: true })
    expect(manifest[0].items).toBe(2)
    const snap = await readJsonLoose<TLooseEnrichmentsFile>(path.join(previousDir(), `${KEY}.json`))
    expect(snap?.items['26-0001'].cacheKey).toBe('old')

    // A second export after records changed must keep the original snapshot.
    await writeJson(paths.enrichments(KEY), { meetingKey: KEY, items: { '26-0001': { ...OLD_RECORD, cacheKey: 'changed' } } })
    await exportChunks([KEY], 30, { all: true })
    const again = await readJsonLoose<TLooseEnrichmentsFile>(path.join(previousDir(), `${KEY}.json`))
    expect(again?.items['26-0001'].cacheKey).toBe('old')
  })
})

describe('enrich-import', () => {
  it('skips items that already have a record unless replace is set', async () => {
    await exportChunks([KEY], 30, { all: true })
    await writeOutput(`${KEY}.01`, [newA, newB])

    const [kept] = await importChunks([KEY], 'sonnet-agent')
    expect(kept).toEqual({ meetingKey: KEY, imported: 1, rejected: 0 })
    let file = await readJsonLoose<TLooseEnrichmentsFile>(paths.enrichments(KEY))
    expect(file?.items['26-0001'].cacheKey).toBe('old')
    expect(file?.items['26-0002'].promptVersion).toBe('enrich.v5.md')

    const [replaced] = await importChunks([KEY], 'sonnet-agent', { replace: true })
    expect(replaced).toEqual({ meetingKey: KEY, imported: 2, rejected: 0 })
    file = await readJsonLoose<TLooseEnrichmentsFile>(paths.enrichments(KEY))
    expect(file?.items['26-0001'].promptVersion).toBe('enrich.v5.md')
    expect(file?.items['26-0001'].modelId).toBe('sonnet-agent')
  })

  it('rejects an item that fails the schema and keeps the rest', async () => {
    await exportChunks([KEY], 30, { all: true })
    await writeOutput(`${KEY}.01`, [newA, { ...newB, subcategory: null }])
    const [summary] = await importChunks([KEY], 'sonnet-agent', { replace: true })
    expect(summary).toEqual({ meetingKey: KEY, imported: 1, rejected: 1 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run pipeline/__tests__/agent-io.test.ts`
Expected: FAIL — `readJsonLoose`, `previousDir` not exported; `exportChunks` ignores the third argument.

- [ ] **Step 3: Add `readJsonLoose` to `store.ts`**

Replace the private `readParsed` (lines 71–79) with:

```ts
/**
 * A file's JSON without validation, or null when it doesn't exist. For migrations and
 * comparisons, where stored records may predate the current schema.
 */
export async function readJsonLoose<T>(file: string): Promise<T | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  return JSON.parse(text) as T
}

async function readParsed<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T> | null> {
  const value = await readJsonLoose<unknown>(file)
  return value === null ? null : schema.parse(value)
}
```

- [ ] **Step 4: Rework `agent-io.ts` export and import**

Replace lines 11–24 (imports through `ENRICH_DIR`) with:

```ts
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Enrichment } from '@oakvs/consent-schema/schema'
import type { TEnrichment, TEnrichmentRecord, TRawItem } from '@oakvs/consent-schema/schema'

import { enrichmentCacheKey } from '../import/prototype'
import { getDataRoot, listRawKeys, paths, readJsonLoose, readRaw, writeJson } from '../store'
import { runChecks } from '../validate/checks'

/** Where chunk inputs and outputs live; `CONSENT_ENRICH_DIR` redirects it (tests). */
export const enrichDir = (): string => process.env.CONSENT_ENRICH_DIR ?? path.join(process.cwd(), '.cache', 'enrich')
/** Snapshot of data/enrichments taken by the first `enrich-export --all`, for `category-diff`. */
export const previousDir = (): string => path.join(enrichDir(), 'previous')
export const AGENT_PROMPT_VERSION = 'enrich.v5.md'

/** An enrichments file read without validation: during a re-run, stored records may predate the schema. */
export type TLooseEnrichmentsFile = {
  meetingKey: string
  items: Record<string, { modelId: string; promptVersion: string; cacheKey: string; output: Record<string, unknown> }>
}
```

Replace every remaining `ENRICH_DIR` in the file with `enrichDir()` (the two path helpers and the `manifest.json` write). Then replace `exportChunks` with:

```ts
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

/** Copy data/enrichments to the snapshot folder, once; later exports keep the original baseline. */
async function snapshotPrevious(): Promise<void> {
  if (await exists(previousDir())) return
  const src = path.join(getDataRoot(), 'enrichments')
  if (await exists(src)) await cp(src, previousDir(), { recursive: true })
}

/**
 * Write chunk inputs. By default only items with no enrichment; with `all`, every item
 * (a full re-run), after snapshotting the current records for `category-diff`.
 */
export async function exportChunks(keys: string[] | null, size: number, opts: { all?: boolean } = {}): Promise<TManifestEntry[]> {
  await mkdir(enrichDir(), { recursive: true })
  if (opts.all) await snapshotPrevious()
  const manifest: TManifestEntry[] = []
  for (const key of keys ?? await listRawKeys()) {
    const [raw, existing] = await Promise.all([readRaw(key), readJsonLoose<TLooseEnrichmentsFile>(paths.enrichments(key))])
    if (!raw) continue
    const todo = opts.all ? raw.items : raw.items.filter(i => !existing?.items[i.file])
    for (let start = 0, n = 1; start < todo.length; start += size, n++) {
      const chunk = `${key}.${String(n).padStart(2, '0')}`
      const input: TChunkInput = {
        chunk,
        meetingKey: key,
        meetingDate: key.slice(0, 10),
        items: todo.slice(start, start + size).map(i => ({
          file: i.file,
          agendaNumber: i.agendaNumber,
          title: i.title,
          text: i.text,
          matterType: i.matterType,
          presenter: i.presenter,
          group: i.group,
          fundingSource: i.fundingSource,
        })),
      }
      await writeFile(inputPath(chunk), `${JSON.stringify(input, null, 2)}\n`)
      manifest.push({ chunk, meetingKey: key, items: input.items.length, input: inputPath(chunk), output: outputPath(chunk) })
    }
  }
  await writeFile(path.join(enrichDir(), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
```

Replace `importChunks` with:

```ts
/**
 * Merge every chunk output for these meetings into data/enrichments. Items failing the
 * schema are rejected. An item that already has a record is skipped unless `replace`.
 */
export async function importChunks(keys: string[] | null, modelId: string, opts: { replace?: boolean } = {}): Promise<TImportSummary[]> {
  const files = (await readdir(enrichDir())).filter(f => f.endsWith('.output.json'))
  const chunksByKey = new Map<string, string[]>()
  for (const f of files) {
    const chunk = f.replace(/\.output\.json$/, '')
    const key = chunk.replace(/\.\d+$/, '')
    if (keys && !keys.includes(key)) continue
    chunksByKey.set(key, [...(chunksByKey.get(key) ?? []), chunk])
  }

  const summaries: TImportSummary[] = []
  for (const [key, chunks] of [...chunksByKey.entries()].sort()) {
    const raw = await readRaw(key)
    if (!raw) continue
    const rawByFile = new Map(raw.items.map(i => [i.file, i]))
    const file: TLooseEnrichmentsFile = (await readJsonLoose<TLooseEnrichmentsFile>(paths.enrichments(key))) ?? { meetingKey: key, items: {} }
    let imported = 0
    let rejected = 0
    for (const chunk of chunks.sort()) {
      const out = JSON.parse(await readFile(outputPath(chunk), 'utf8')) as { items: Record<string, unknown>[] }
      for (const candidate of out.items) {
        const { file: fileNo, ...rest } = candidate as { file: string }
        const source = rawByFile.get(fileNo)
        const parsed = Enrichment.safeParse(rest)
        if (!source || !parsed.success) {
          rejected++
          continue
        }
        if (file.items[fileNo] && !opts.replace) continue
        const record: TEnrichmentRecord = {
          modelId,
          promptVersion: AGENT_PROMPT_VERSION,
          cacheKey: enrichmentCacheKey(source.text, source.title, AGENT_PROMPT_VERSION, modelId),
          output: parsed.data,
        }
        file.items[fileNo] = record
        imported++
      }
    }
    await writeJson(paths.enrichments(key), file)
    summaries.push({ meetingKey: key, imported, rejected })
  }
  return summaries
}
```

Remove the now-unused `readEnrichments` and `TEnrichmentsFile` imports from this file.

- [ ] **Step 5: Wire the CLI**

In `pipeline/cli.ts` `parseArgs` options add:

```ts
    all: { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
```

Update the two cases:

```ts
    case 'enrich-export': {
      const manifest = await exportChunks(values.key ? [values.key] : null, Number(values.size ?? 30), { all: values.all })
      const items = manifest.reduce((sum, m) => sum + m.items, 0)
      console.log(`exported ${manifest.length} chunk(s), ${items} item(s) → .cache/enrich/manifest.json${values.all ? ' (all items; previous records snapshotted to .cache/enrich/previous)' : ''}`)
      break
    }
```

```ts
    case 'enrich-import': {
      if (!values.model) throw new Error('--model is required')
      for (const s of await importChunks(values.key ? [values.key] : null, values.model, { replace: values.replace })) {
        console.log(`${s.meetingKey}: imported ${s.imported}, rejected ${s.rejected}`)
      }
      break
    }
```

And the help comment lines 25 and 27:

```
 *   enrich-export [--key K] [--size 30] [--all]  Write agent input chunks (.cache/enrich); --all = every item, for a re-run
 *   enrich-import [--key K] --model M [--replace]  Merge validated chunk outputs into data/enrichments; --replace overwrites
```

- [ ] **Step 6: Run the tests and type-check**

Run: `npx vitest run pipeline/__tests__/agent-io.test.ts && npm run type-check`
Expected: 4 tests PASS; type-check clean except `pipeline/build/totals.ts` (Task 5).

- [ ] **Step 7: Document the commands in RUNBOOK**

In `RUNBOOK.md` "Commands" block, after the `llm-compare` line add:

```bash
npm run consent:enrich-export -- --all             # chunk every item for a swarm re-run; snapshots data/enrichments to .cache/enrich/previous
npm run consent:enrich-import -- --model sonnet-agent --replace   # merge swarm output, overwriting existing records
npm run consent:category-diff                      # what moved: category matrix, movers, sub-categories (.cache/enrich/category-diff.json)
```

- [ ] **Step 8: Commit**

```bash
git add pipeline/store.ts pipeline/enrich/agent-io.ts pipeline/cli.ts pipeline/__tests__/agent-io.test.ts RUNBOOK.md
git commit -m "enrich-export --all and enrich-import --replace for a full re-run

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `category-diff`

**Files:**
- Create: `pipeline/enrich/category-diff.ts`
- Modify: `pipeline/cli.ts` (help line, new case)
- Modify: `package.json` scripts (`consent:category-diff`)
- Create: `pipeline/__tests__/category-diff.test.ts`

**Interfaces:**
- Consumes: `TLooseEnrichmentsFile`, `previousDir()` from Task 3; `spendingAmount` from `@oakvs/consent-schema/format`.
- Produces: `diffEnrichments(previous, current): TCategoryDiff` (pure), `categoryDiff(): Promise<TCategoryDiff>` (reads the two folders), `formatCategoryDiff(d): string`.

- [ ] **Step 1: Write the failing test**

Create `pipeline/__tests__/category-diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { diffEnrichments, formatCategoryDiff } from '../enrich/category-diff'

import { makeEnrichment } from './helpers'

import type { TLooseEnrichmentsFile } from '../enrich/agent-io'

const rec = (output: Record<string, unknown>, promptVersion = 'enrich.v3.md'): TLooseEnrichmentsFile['items'][string] =>
  ({ modelId: 'sonnet-agent', promptVersion, cacheKey: 'k', output })

const previous = new Map<string, TLooseEnrichmentsFile>([
  ['2026-01-14', {
    meetingKey: '2026-01-14',
    items: {
      // Old codebook: a value v2 no longer has, and no subcategory field at all.
      '26-0001': rec({ ...makeEnrichment(), category: 'Legal, insurance & risk', subcategory: undefined }),
      '26-0002': rec({ ...makeEnrichment({ headline: 'Arts during the day' }), category: 'After-school & summer programs', subcategory: undefined }),
      '26-0003': rec({ ...makeEnrichment(), category: 'Special education', subcategory: undefined }),
      '26-0009': rec({ ...makeEnrichment(), subcategory: undefined }),
    },
  }],
])

const current = new Map<string, TLooseEnrichmentsFile>([
  ['2026-01-14', {
    meetingKey: '2026-01-14',
    items: {
      '26-0001': rec({ ...makeEnrichment(), category: 'Legal, compliance & risk' }, 'enrich.v5.md'),
      '26-0002': rec({ ...makeEnrichment({ headline: 'Arts during the day', money: { thisAction: 100_000 } }), category: 'Classroom & academic programs' }, 'enrich.v5.md'),
      '26-0003': rec({ ...makeEnrichment({ money: { thisAction: 50_000 } }), category: 'Special education', subcategory: 'Transportation' }, 'enrich.v5.md'),
      '26-0010': rec({ ...makeEnrichment() }, 'enrich.v5.md'),
    },
  }],
])

describe('category-diff', () => {
  const d = diffEnrichments(previous, current)

  it('compares items present on both sides and lists the rest', () => {
    expect(d.compared).toBe(3)
    expect(d.onlyPrevious).toEqual(['2026-01-14:26-0009'])
    expect(d.onlyCurrent).toEqual(['2026-01-14:26-0010'])
  })

  it('counts moves in a from→to matrix with spending', () => {
    expect(d.changed).toBe(2)
    expect(d.matrix['Legal, insurance & risk']['Legal, compliance & risk']).toEqual({ items: 1, spending: 100_000 })
    expect(d.matrix['After-school & summer programs']['Classroom & academic programs']).toEqual({ items: 1, spending: 100_000 })
    expect(d.matrix['Special education']).toBeUndefined()
  })

  it('lists movers with the new sub-category and tallies sub-categories', () => {
    expect(d.movers).toEqual([
      { id: '2026-01-14:26-0001', headline: 'Pays Acme up to $100,000 for tutoring', from: 'Legal, insurance & risk', to: 'Legal, compliance & risk', subcategory: null },
      { id: '2026-01-14:26-0002', headline: 'Arts during the day', from: 'After-school & summer programs', to: 'Classroom & academic programs', subcategory: null },
    ])
    expect(d.subcategories).toEqual({ Transportation: { items: 1, spending: 50_000 } })
  })

  it('formats a readable summary', () => {
    const text = formatCategoryDiff(d)
    expect(text).toContain('3 items compared, 2 changed category')
    expect(text).toContain('After-school & summer programs → Classroom & academic programs: 1')
    expect(text).toContain('Transportation: 1 items')
  })

  it('is deterministic', () => {
    expect(JSON.stringify(diffEnrichments(previous, current))).toBe(JSON.stringify(d))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run pipeline/__tests__/category-diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pipeline/enrich/category-diff.ts`**

```ts
/**
 * `consent category-diff`: compare the enrichments snapshotted by
 * `enrich-export --all` (.cache/enrich/previous) with the current
 * data/enrichments, item by item. Pure code, no LLM; both sides are read
 * without validation because the snapshot predates the current schema.
 *
 * Spending here is `spendingAmount(money)` straight from each record; the
 * build's counting flags (budget allocations, payment ratifications) aren't
 * applied, so treat the dollar figures as "about", for review.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { spendingAmount } from '@oakvs/consent-schema/format'
import type { TMoney } from '@oakvs/consent-schema/schema'

import { getDataRoot, readJsonLoose } from '../store'

import { previousDir } from './agent-io'

import type { TLooseEnrichmentsFile } from './agent-io'

type TBucket = { items: number; spending: number }

export type TCategoryDiff = {
  compared: number
  changed: number
  /** from → to → items and spending (current record's money). Only off-diagonal cells. */
  matrix: Record<string, Record<string, TBucket>>
  /** Special education sub-categories in the current records. */
  subcategories: Record<string, TBucket>
  /** Every item whose category changed, sorted by id. */
  movers: { id: string; headline: string; from: string; to: string; subcategory: string | null }[]
  onlyPrevious: string[]
  onlyCurrent: string[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '(none)')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const spend = (output: Record<string, unknown>): number => spendingAmount((output.money ?? null) as TMoney | null)
const add = (b: TBucket | undefined, spending: number): TBucket => ({ items: (b?.items ?? 0) + 1, spending: (b?.spending ?? 0) + spending })
const sortKeys = <T,>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

export function diffEnrichments(previous: Map<string, TLooseEnrichmentsFile>, current: Map<string, TLooseEnrichmentsFile>): TCategoryDiff {
  const d: TCategoryDiff = { compared: 0, changed: 0, matrix: {}, subcategories: {}, movers: [], onlyPrevious: [], onlyCurrent: [] }
  const keys = [...new Set([...previous.keys(), ...current.keys()])].sort()
  for (const key of keys) {
    const before = previous.get(key)?.items ?? {}
    const after = current.get(key)?.items ?? {}
    for (const file of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const id = `${key}:${file}`
      const a = before[file]
      const b = after[file]
      if (!a) {
        d.onlyCurrent.push(id)
        continue
      }
      if (!b) {
        d.onlyPrevious.push(id)
        continue
      }
      d.compared++
      const from = str(a.output.category)
      const to = str(b.output.category)
      const subcategory = strOrNull(b.output.subcategory)
      const spending = spend(b.output)
      if (to === 'Special education' && subcategory) d.subcategories[subcategory] = add(d.subcategories[subcategory], spending)
      if (from === to) continue
      d.changed++
      d.matrix[from] = { ...d.matrix[from], [to]: add(d.matrix[from]?.[to], spending) }
      d.movers.push({ id, headline: str(b.output.headline), from, to, subcategory })
    }
  }
  d.matrix = sortKeys(Object.fromEntries(Object.entries(d.matrix).map(([k, v]) => [k, sortKeys(v)])))
  d.subcategories = sortKeys(d.subcategories)
  return d
}

async function readLooseDir(dir: string): Promise<Map<string, TLooseEnrichmentsFile>> {
  const out = new Map<string, TLooseEnrichmentsFile>()
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of files.sort()) {
    const value = await readJsonLoose<TLooseEnrichmentsFile>(path.join(dir, f))
    if (value) out.set(f.replace(/\.json$/, ''), value)
  }
  return out
}

/** Compare the snapshot with the live enrichments. */
export async function categoryDiff(): Promise<TCategoryDiff> {
  const [previous, current] = await Promise.all([readLooseDir(previousDir()), readLooseDir(path.join(getDataRoot(), 'enrichments'))])
  if (previous.size === 0) throw new Error(`no snapshot in ${previousDir()}; run enrich-export --all first`)
  return diffEnrichments(previous, current)
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`

export function formatCategoryDiff(d: TCategoryDiff): string {
  const lines = [`${d.compared} items compared, ${d.changed} changed category; ${d.onlyPrevious.length} only before, ${d.onlyCurrent.length} only after`, '']
  lines.push('Moves (from → to: items, spending of the new records):')
  for (const [from, tos] of Object.entries(d.matrix)) {
    for (const [to, b] of Object.entries(tos)) lines.push(`  ${from} → ${to}: ${b.items} (${money(b.spending)})`)
  }
  lines.push('', 'Special education sub-categories:')
  for (const [sub, b] of Object.entries(d.subcategories)) lines.push(`  ${sub}: ${b.items} items (${money(b.spending)})`)
  return lines.join('\n')
}
```

- [ ] **Step 4: Wire the CLI and npm script**

`pipeline/cli.ts`: help line after `enrich-import`:

```
 *   category-diff                             Compare .cache/enrich/previous with data/enrichments → .cache/enrich/category-diff.json
```

New case next to `enrich-import`:

```ts
    case 'category-diff': {
      const { categoryDiff, formatCategoryDiff } = await import('./enrich/category-diff')
      const { enrichDir } = await import('./enrich/agent-io')
      const diff = await categoryDiff()
      await writeJson(path.join(enrichDir(), 'category-diff.json'), diff)
      console.log(formatCategoryDiff(diff))
      console.log(`\n${diff.movers.length} movers listed in ${path.join(enrichDir(), 'category-diff.json')}`)
      break
    }
```

`package.json` scripts, after `consent:enrich-import`: `"consent:category-diff": "tsx pipeline/cli.ts category-diff",`

- [ ] **Step 5: Run the tests**

Run: `npx vitest run pipeline/__tests__/category-diff.test.ts && npm run type-check`
Expected: 5 tests PASS; type-check unchanged from Task 3.

- [ ] **Step 6: Commit**

```bash
git add pipeline/enrich/category-diff.ts pipeline/cli.ts package.json pipeline/__tests__/category-diff.test.ts
git commit -m "category-diff: what moved between two sets of summaries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `bySubcategory` totals and the CSV column

**Files:**
- Modify: `pipeline/build/totals.ts:28,75-77,89`
- Modify: `pipeline/build/exports.ts:50`
- Test: `pipeline/__tests__/build.test.ts` (append to `describe('totals')`)

**Interfaces:**
- Consumes: `TTotals.bySubcategory` (Task 1).
- Produces: `items.csv` and `meetings/{key}.csv` gain a `subcategory` column right after `category`.

- [ ] **Step 1: Write the failing test**

Append inside `describe('totals', …)` in `pipeline/__tests__/build.test.ts`:

```ts
  it('tallies special education sub-categories with the same counting rules as categories', () => {
    const sped = (subcategory: 'Transportation' | 'Services & contract staff', thisAction: number): ReturnType<typeof makeEnrichment> =>
      makeEnrichment({ category: 'Special education', subcategory, money: { thisAction } })
    const totals = computeTotals([
      item('26-0001', { enrichment: sped('Transportation', 50_000) }),
      item('26-0002', { enrichment: sped('Transportation', 25_000) }),
      item('26-0003', { enrichment: sped('Services & contract staff', 10_000) }),
      // Flagged budget allocation: counted as a budget item, never as sub-category spending.
      item('26-0004', { enrichment: sped('Services & contract staff', 999_999), flags: ['budget_allocation'] }),
      // Not counted at all (e.g. a duplicate listing).
      item('26-0005', { enrichment: sped('Transportation', 999_999), countsTowardTotals: false }),
      item('26-0006'),
    ])
    expect(totals.bySubcategory).toEqual({
      Transportation: { items: 2, spending: 75_000 },
      'Services & contract staff': { items: 1, spending: 10_000 },
    })
    expect(totals.byCategory['Special education']).toEqual({ items: 3, spending: 85_000 })
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run pipeline/__tests__/build.test.ts -t "sub-categories"`
Expected: FAIL — `bySubcategory` undefined (and type-check error at `totals.ts`).

- [ ] **Step 3: Implement**

`pipeline/build/totals.ts`: in the initial object after `byCategory: {},` add `bySubcategory: {},`. After the `byCategory` bucket lines (around line 75–77) add:

```ts
    if (e.subcategory) {
      const sub = (totals.bySubcategory[e.subcategory] ??= { items: 0, spending: 0 })
      sub.items++
      sub.spending += spend
    }
```

After line 89 add: `for (const bucket of Object.values(totals.bySubcategory)) bucket.spending = cents(bucket.spending)`

`pipeline/build/exports.ts`: after the `category` column (line 50) add:

```ts
  { name: 'subcategory', type: 'string', description: 'Special education sub-category (AI classification); empty for other categories.', get: r => r.item.enrichment?.subcategory },
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run pipeline/__tests__/build.test.ts -t "totals" && npm run type-check`
Expected: totals tests PASS; `npm run type-check` clean (this was the last outstanding type error).

- [ ] **Step 5: Commit**

```bash
git add pipeline/build/totals.ts pipeline/build/exports.ts pipeline/__tests__/build.test.ts
git commit -m "Totals by special-ed sub-category; subcategory column in exports

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Pilot on three meetings

No code in this task beyond the Workflow script; it validates the codebook before the full run. Requires the user to have paused the scheduler (see Global Constraints).

**Files:**
- Read: `.cache/enrich/manifest.json`, `.cache/enrich/category-diff.json`
- Modify (if the pilot shows a rule problem): `pipeline/prompts/enrich.v5.md`
- Modify (after review): `data/fixtures/golden/2026-06-24/*.json`

- [ ] **Step 1: Confirm preconditions**

Ask the user to confirm in chat that the GitHub Actions `consent run` workflow is disabled (`gh workflow disable "consent run"`) and the homelab standby cron is stopped. Do not proceed without that confirmation. Then:

```bash
git status --short   # only BRIEF.md (untracked) may show; the tree must otherwise be clean
```

- [ ] **Step 2: Export the pilot chunks**

Each `enrich-export` call rewrites `manifest.json` for the keys it was given, so collect the chunk ids as you go:

```bash
mkdir -p .cache/enrich && : > .cache/enrich/pilot-chunks.txt
for k in 2026-06-24 2024-01-10 2021-10-13; do
  npm run consent:enrich-export -- --all --key "$k"
  node -e 'console.log(require("./.cache/enrich/manifest.json").map(c=>c.chunk).join("\n"))' >> .cache/enrich/pilot-chunks.txt
done
node -e 'const ids=require("fs").readFileSync(".cache/enrich/pilot-chunks.txt","utf8").trim().split("\n");console.log(ids.length,"chunks");console.log(JSON.stringify(ids))'
```

Expected: about 9–12 chunks across the three keys, printed as a JSON array for Step 3; `.cache/enrich/previous/` now holds a copy of every file in `data/enrichments/` (the snapshot is taken on the first `--all`, regardless of `--key`).

- [ ] **Step 3: Run the swarm on the pilot chunks**

Call `mcp__ccd_host__request_keep_awake` first. Then invoke the Workflow tool with the script below inline and `args` set to the chunk id array printed in Step 2 (as a JSON array, e.g. `["2026-06-24.01", "2026-06-24.02", …]`). Record the `scriptPath` and `runId` from the result.

```js
export const meta = {
  name: 'enrich-v5-swarm',
  description: 'Summarize consent-item chunks with prompt enrich.v5.md via Sonnet sub-agents, each validated with enrich-check',
  phases: [
    { title: 'Enrich', detail: 'one agent per chunk of ~30 items', model: 'sonnet' },
    { title: 'Retry', detail: 'a fresh agent for each chunk that did not pass', model: 'sonnet' },
  ],
}

const LEDGER = {
  type: 'object',
  properties: {
    chunk: { type: 'string' },
    passed: { type: 'boolean' },
    rounds: { type: 'number' },
    errors: { type: 'array', items: { type: 'string' } },
  },
  required: ['chunk', 'passed', 'rounds', 'errors'],
}

const prompt = (chunk, retryNote) => `You are one worker in a swarm re-summarizing Oakland Unified School District Board consent items for a public transparency tool. Work only on chunk ${chunk}.

1. Read the codebook in full: pipeline/prompts/enrich.v5.md. Follow it exactly; it is the only set of rules. You are in "agent mode" as that file describes.
2. Read .cache/enrich/${chunk}.input.json. It has { chunk, meetingKey, meetingDate, items }.
3. For every item write one enrichment object per the codebook. The official \`text\` is the only source of truth: never compute, round or infer a dollar figure; copy \`evidence\` character for character from \`text\`.
4. Write .cache/enrich/${chunk}.output.json as { "chunk": "${chunk}", "items": [ { "file": "<the item's file>", ...the enrichment fields } ] }, one entry per input item, in input order. \`byYear\` is an object keyed by year label, e.g. {"2026-27": 323511.63}, or {}. \`subcategory\` is one of the five values for Special education items and null for every other item.
5. Run: npm run consent:enrich-check -- --chunk ${chunk}
   Fix every line marked ERROR and run it again, up to 3 rounds. WARNING lines are advisory: fix them when the fix is clear, but don't loop on them.
6. Don't edit any other file and don't read other chunks' files.
${retryNote}
Return: chunk, passed (true only if the last check printed PASS), rounds (how many times you ran the check), and errors (the ERROR lines still remaining, or []).`

const results = await pipeline(
  args,
  chunk => agent(prompt(chunk, ''), { label: `enrich:${chunk}`, phase: 'Enrich', schema: LEDGER, model: 'sonnet' }),
  (first, chunk) => (first && first.passed)
    ? first
    : agent(
        prompt(chunk, `A previous agent did not pass the checks. Start from the input file, not from any existing output file. Its remaining errors were: ${first ? first.errors.join(' | ') : 'none recorded (the agent returned nothing)'}`),
        { label: `retry:${chunk}`, phase: 'Retry', schema: LEDGER, model: 'sonnet' },
      ),
)

const ledger = results.map((r, i) => r || { chunk: args[i], passed: false, rounds: 0, errors: ['agent returned nothing'] })
const failed = ledger.filter(r => !r.passed).map(r => r.chunk)
log(`${ledger.length - failed.length}/${ledger.length} chunks passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`)
return { passed: ledger.length - failed.length, failed, ledger }
```

Expected: the result's `failed` is empty, or lists a few chunks to handle in Step 7.

- [ ] **Step 4: Import and diff**

```bash
for k in 2026-06-24 2024-01-10 2021-10-13; do npm run consent:enrich-import -- --key "$k" --model sonnet-agent --replace; done
npm run consent:category-diff
```

Expected: `imported N, rejected 0` per meeting (the swarm validated every chunk), and the diff summary. Because only three meetings were replaced, most rows are unchanged; look at the `Moves` block for those meetings.

- [ ] **Step 5: Review the movers by hand**

```bash
node -e '
const d=require("./.cache/enrich/category-diff.json");
const pilot=new Set(["2026-06-24","2024-01-10","2021-10-13"]);
const m=d.movers.filter(x=>pilot.has(x.id.slice(0,10)));
console.log(m.length,"movers in pilot meetings");
for(const x of m) console.log(`${x.from} → ${x.to}${x.subcategory?" / "+x.subcategory:""}\n    ${x.id}  ${x.headline}`);
console.log("\nsub-categories:",d.subcategories);'
```

Check, against each item's official text (`data/raw/{key}.json`):
- Every After-school → Classroom move: does the text really lack after-school/summer/expanded-learning language? Every item that stayed After-school: does the text have it?
- Every move into Budget, finance & payments: is it a budget, plan, warrant/payroll ratification, audit or fund transfer?
- Every Special education item in 2026-06-24: is the sub-category right? In particular the $67.66M NPS resolution (26-1315 → Nonpublic schools & agencies), Zum (26-1284 → Transportation), and any staffing-agency contract (→ Services & contract staff).
- Any move that looks wrong: find the rule that caused it.

Also run the money regression check on the largest pilot meeting:

```bash
npx tsx --env-file=.env pipeline/cli.ts llm-compare --key 2026-06-24 --sample 20
```

Read `.cache/llm-compare-2026-06-24.json`: `agreement` for `money.thisAction`, `money.direction`, `money.amountType` should be at or near 20/20 (the compare runs the API path against the just-imported agent records; both are v5, so disagreements point at genuinely ambiguous items, not the prompt).

- [ ] **Step 6: Iterate the prompt if needed**

If a rule caused wrong moves, edit `pipeline/prompts/enrich.v5.md` in place (v5 isn't published yet, so this is the one time editing in place is right), commit the edit, delete the affected chunks' `.output.json` files, and re-run Steps 3–5 for those meetings with `Workflow({ scriptPath, args: [affected chunk ids] })`. Repeat until the movers list reads right. Keep a note of each change; it goes into the README note in Task 9.

- [ ] **Step 7: Handle any chunk the swarm couldn't pass**

For each chunk in `failed`: open its `.output.json`, run `npm run consent:enrich-check -- --chunk <id>`, and fix the specific items by hand against the official text (these are almost always `evidence` not an exact substring, or an amount the text prints oddly). Re-run the check until PASS, then re-import with `--replace`.

- [ ] **Step 8: Update the golden fixtures**

For each `data/fixtures/golden/2026-06-24/*.json`, compare `expected.category` with the newly imported record (`data/enrichments/2026-06-24.json`, `items[file].output`). Where the new category is right under v5 (e.g. a budget item now `Budget, finance & payments`), update `expected.category`. Add `"subcategory": "<value>"` to `expected` for the special-education fixtures (R.-62 Zum → `"Transportation"`; check each). Then extend the golden test in `pipeline/__tests__/build.test.ts` (the `for (const f of fixtures)` block): change the `expected` type to include `subcategory?: string | null` and add after the category assertion:

```ts
      if ('subcategory' in golden.expected) expect(published!.enrichment!.subcategory).toBe(golden.expected.subcategory ?? null)
```

Fixtures whose `verified` is `false` carry a note saying so; leave that alone.

- [ ] **Step 9: Commit the pilot**

```bash
git add data/enrichments/2026-06-24.json data/enrichments/2024-01-10.json data/enrichments/2021-10-13.json data/fixtures/golden pipeline/__tests__/build.test.ts pipeline/prompts/enrich.v5.md
git commit -m "Pilot: re-summarize three meetings under codebook v5; golden fixtures for v5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Full swarm

**Files:**
- Read/write: `.cache/enrich/*` (never committed)
- Modify: `data/enrichments/*.json` (all 162)

- [ ] **Step 1: Export everything**

```bash
npm run consent:enrich-export -- --all
node -e 'const m=require("./.cache/enrich/manifest.json");const done=new Set(["2026-06-24","2024-01-10","2021-10-13"]);const todo=m.filter(c=>!done.has(c.meetingKey)).map(c=>c.chunk);require("fs").writeFileSync(".cache/enrich/todo.json",JSON.stringify(todo));console.log(m.length,"chunks total,",todo.length,"to run")'
```

Expected: about 403 chunks total, ~390 to run (the pilot meetings are already v5; skipping them keeps the pilot's reviewed records). The snapshot in `previous/` is untouched (taken in Task 6).

- [ ] **Step 2: Run the swarm**

`mcp__ccd_host__request_keep_awake`, then `Workflow({ scriptPath: <from Task 6>, args: <contents of .cache/enrich/todo.json as a JSON array> })`. Expect several hours; the tool notifies on completion. If the session is interrupted, resume with `Workflow({ scriptPath, resumeFromRunId })` — completed chunks return from cache, and their output files are already on disk.

Chunk outputs land as they complete; nothing is imported until Step 3, so a partial run never reaches `data/`.

- [ ] **Step 3: Import, then diff**

```bash
npm run consent:enrich-import -- --model sonnet-agent --replace
npm run consent:category-diff
```

Expected: every meeting reports `rejected 0`. If a meeting reports rejections, those items' chunk output failed the schema even though the agent reported PASS; run `enrich-check` on that chunk, fix, re-import.

- [ ] **Step 4: Send stragglers through the API**

For every chunk in the workflow result's `failed` that Step 7-style hand-fixing isn't worth (more than a handful of items), delete those items' records so the API path sees them as missing, then let `consent:llm` enrich them:

```bash
# For one failed chunk: list its files, delete their records, enrich via API.
CHUNK=2023-03-08.02
node -e '
const fs=require("fs");const c=process.argv[1];const key=c.replace(/\.\d+$/,"");
const inp=JSON.parse(fs.readFileSync(`.cache/enrich/${c}.input.json`));
const p=`data/enrichments/${key}.json`;const f=JSON.parse(fs.readFileSync(p));
for(const it of inp.items) delete f.items[it.file];
fs.writeFileSync(p, JSON.stringify(f));console.log("deleted",inp.items.length,"records from",key)' "$CHUNK"
npx tsx --env-file=.env pipeline/cli.ts llm --key "${CHUNK%.*}"
```

(`consent llm` rewrites the file through `writeJson`, restoring stable formatting.) The API path records `modelId` as the served Opus model and `promptVersion: enrich.v5.md`.

- [ ] **Step 5: Review the full diff**

```bash
node -e '
const d=require("./.cache/enrich/category-diff.json");
console.log(`${d.compared} compared, ${d.changed} changed (${(100*d.changed/d.compared).toFixed(1)}%)`);
for(const [from,tos] of Object.entries(d.matrix)) for(const [to,b] of Object.entries(tos)) if(b.items>=20) console.log(String(b.items).padStart(5), from,"→",to);
console.log(d.subcategories);'
```

For every from→to cell with 20+ items, read 5 movers' official text and confirm the move follows a v5 rule. Expected large cells: Classroom → Budget (Measure N/H plans), Governance → Budget (payment ratifications, budgets), After-school → Classroom (daytime programs), Legal, insurance & risk → Legal, compliance & risk (the rename; should be nearly every former legal item). A large unexpected cell means a prompt problem: stop, fix the prompt as in Task 6 Step 6, and re-run the affected meetings only.

Spot-check that `d.onlyPrevious` and `d.onlyCurrent` are empty (every item was replaced, none appeared or vanished).

- [ ] **Step 6: Commit the enrichments**

Do not commit yet if Step 5 found a problem. Otherwise:

```bash
git add data/enrichments
git commit -m "Re-summarize every item under codebook v5 (agent swarm)

$(node -e 'const d=require("./.cache/enrich/category-diff.json");console.log(`${d.compared} items compared, ${d.changed} changed category.`)')

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Second readings through the API

**Files:**
- Modify: `data/verifications/*.json`, `data/llm-state.json` (by the pipeline)

- [ ] **Step 1: Raise the monthly cap for this month and confirm what will run**

In `.env` set `CONSENT_LLM_MONTHLY_CAP_USD=150` (the default $25 can't cover ~4,000 Sonnet readings plus any Opus tie-breaks; the real spend should land near $20–30). Then preview:

```bash
npx tsx --env-file=.env pipeline/cli.ts run --dry-run 2>&1 | grep -i -A3 "llm" | head -20
```

Expected: the plan lists `verify` counts for every meeting and `enrich: 0` (every item already has a current v5 record).

- [ ] **Step 2: Run it**

```bash
npx tsx --env-file=.env pipeline/cli.ts llm
```

`llm` with no `--key` loops every meeting (`llmPhase` falls back to `listRawKeys()`), re-reads each item whose verification is stale by cache key, then rebuilds. Expect 30–60 minutes at concurrency 4. If it stops with `monthly cap reached`, raise the cap and re-run; it continues where it left off.

- [ ] **Step 3: Check the result**

```bash
node -e '
const fs=require("fs");let total=0,stale=0;
for(const f of fs.readdirSync("data/verifications")){const v=JSON.parse(fs.readFileSync("data/verifications/"+f));const e=JSON.parse(fs.readFileSync("data/enrichments/"+f));
for(const [file,r] of Object.entries(v.items)){total++;if(e.items[file]?.cacheKey!==r.enrichmentCacheKey)stale++}}
console.log("verifications:",total,"stale:",stale)'
grep -c '"verify:' data/llm-state.json || true
```

Expected: `stale: 0`. Any `verify:` failure entries in `data/llm-state.json` are retried by the next `llm` run (once a day by design); if a few remain, run `llm --key <meeting>` for them after the retry window or leave them for the scheduler, which is acceptable.

- [ ] **Step 4: Commit**

```bash
git add data/verifications data/llm-state.json
git commit -m "Second readings for the v5 summaries (Claude API)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Build, full test suite, README and RUNBOOK

**Files:**
- Modify: `README.md:19-25` (What you'll find), `:53-56` (step 3), new subsection after step 3, `:95-97` (models paragraph)
- Modify: `RUNBOOK.md` (new sections under "When something goes wrong")
- Regenerate: `data/published/`, `data/exports/`, README generated sections

- [ ] **Step 1: Build and run everything**

```bash
npm run consent:build
npm test
npm run type-check
```

Expected: build prints 162 meetings; all tests PASS, including the ones that were red since Task 1 (`llm.test.ts` round-trip now covers v5 records; golden set; exports; README stats). Two expected exceptions:
- `readme.test.ts` "are current" fails until Step 2 has run; `consent:build` rewrites the generated README sections, so re-run the build after editing the README and run the test again.
- `build.test.ts` "matches the §18.5 prototype numbers" pins `spendingItems`, `spendingTotal`, `yearlyCapItems` and three flag counts for 2026-06-24. A re-read can legitimately move an item between spending and yearly caps. If it fails, list the items whose `money.amountType` or `thisAction` differs between `.cache/enrich/previous/2026-06-24.json` and `data/enrichments/2026-06-24.json`, confirm each new reading against the official text and its second reading (`data/verifications/2026-06-24.json`), and only then update the pinned numbers with a comment naming the item(s), in the style of the existing R.-225 comment. If a new reading is wrong, fix it with an override, not by editing the test.

- [ ] **Step 2: README — what you'll find, and how items are categorized**

In "What you'll find in each item", change the AI sentence to:

> Then, some of it is written by AI and then checked. That covers the headline and summary, the category and action type (and, for special education items, a sub-category), the vendor name, any schools mentioned, the contract dates, the dollar amounts, and four of the flags.

Insert a new subsection directly after "### 3. Summarizing each item":

```markdown
### How items are categorized

Each item gets one of 13 categories, chosen by the AI from the official text alone against a written codebook, [`pipeline/prompts/enrich.v5.md`](pipeline/prompts/enrich.v5.md), and listed with definitions on the site's [about page](https://oakvs.world/consent-tracker/about). A category says what the money or action is *for*: a busing contract for special education students is Special education, not transportation, and software bought for a reading program goes with the program, not under Technology. It isn't based on which office presented the item or what kind of organization the vendor is. Special education items also get one of five sub-categories (nonpublic schools and agencies; transportation; services and contract staff; programs and support; legal, compliance and policy), because that one category is about a tenth of all counted spending and a single label hid what was in it. Code checks what it can (every special education item must have a sub-category and no other item may), and like everything else the AI writes, a category can be corrected by a person through [`data/overrides/`](data/overrides/).

**October 2026 re-categorization.** The codebook was revised (prompt v5) and every item since 2019 was re-summarized under it, so the whole dataset follows one set of rules. What changed: a "Budget, finance & payments" category for the district's own budget plans and payment ratifications, which had been split across three categories; "Legal, insurance & risk" became "Legal, compliance & risk"; the after-school rule now requires the text itself to place a program outside the school day, after items like daytime arts classes had landed there; and the special education sub-categories were added. {CHANGED} of {COMPARED} items changed category. Earlier summaries were written by Claude Sonnet agents under prompts v2 and v3; every record now says `enrich.v5.md`. The before-and-after comparison is in the commit that made the change.
```

Replace `{CHANGED}` and `{COMPARED}` with the `changed` and `compared` values from `.cache/enrich/category-diff.json`, formatted with thousands separators (e.g. `1,234 of 12,071`). Then update the paragraph under "Which models wrote what" so `enrich.v4` reads `enrich.v5`:

> New items from October 2026 on are summarized by Claude Opus 5.5 through the Claude API (prompt `enrich.v5`), …

Run `npm run consent:build` again so the generated sections (stats, models table) match, then `npx vitest run pipeline/__tests__/readme.test.ts` — expected PASS.

- [ ] **Step 3: RUNBOOK — re-running every summary, and the schema bump checklist**

Under "## When something goes wrong", before "### Changing the model or a prompt", add:

```markdown
### Re-running every summary

Only for a codebook change that should apply to the whole dataset (October 2026: `enrich.v5`). Every published headline and summary changes, so this is a planned, one-shot migration:

1. Pause the scheduler: `gh workflow disable "consent run"` and stop the homelab standby. Nothing may push `main` until step 8.
2. Work on a branch. `npm run consent:enrich-export -- --all` writes a chunk per ~30 items to `.cache/enrich/` and snapshots the current `data/enrichments/` to `.cache/enrich/previous/` (once).
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
3. In `oakvs`: `SUPPORTED_SCHEMA_MAJOR` in `src/lib/consent/data.ts`, plus any renamed slugs in `src/app/consent-tracker/layout.module.scss`. Merge that before pushing the data.
```

- [ ] **Step 4: Commit**

```bash
git add README.md RUNBOOK.md data/published data/exports
git commit -m "Build and docs for codebook v5: how items are categorized, re-run and schema-bump runbooks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Site lockstep change (oakvs repo)

**Files (in `/Users/oppodeldoc/code/oakvs`, branch off `next`):**
- Modify: `src/lib/consent/data.ts:35`
- Modify: `src/app/consent-tracker/layout.module.scss:57-61` (rename key), add a pair
- Modify: `src/app/consent-tracker/about/page.tsx:6-7` (imports), `:210-238` (categories section)

- [ ] **Step 1: Branch**

```bash
cd /Users/oppodeldoc/code/oakvs && git checkout next && git pull && git checkout -b consent-schema-2
```

- [ ] **Step 2: Version gate and colors**

`src/lib/consent/data.ts:35`: `export const SUPPORTED_SCHEMA_MAJOR = 2`

`layout.module.scss`: rename the key `legal-insurance-risk` to `legal-compliance-risk` (same two colors), and add after `student-health-support`:

```scss
  budget-finance-payments: (
    #c9c9c9,
    #5f5f5f,
  ),
```

Both values must meet WCAG AA 4.5:1 against the page background in their theme, like the pairs above (light-on-dark first, dark-on-light second). Check with any contrast tool against the two `--color-bg` values used in this file.

- [ ] **Step 3: About page: sub-category table and the note**

Imports:

```tsx
import { ACTION_LABELS, ACTION_NOTES, CATEGORY_NOTES, FLAG_LABELS, FLAG_ORDER, SUBCATEGORY_NOTES } from '@oakvs/consent-schema/labels'
import { ActionType, Category, LlmFlag, SpecialEdSubcategory } from '@oakvs/consent-schema/schema'
```

Inside `<section id="categories">`, after the categories `</table>`, add:

```tsx
        <h3>Special education sub-categories</h3>
        <p>
          Special education is about a tenth of all counted spending, so each of its items also gets one sub-category,
          assigned the same way from the official text.
        </p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Sub-category</th>
              <th scope="col">What it covers</th>
            </tr>
          </thead>
          <tbody>
            {SpecialEdSubcategory.options.map(sub => (
              <tr key={sub}>
                <th scope="row">{sub}</th>
                <td>{SUBCATEGORY_NOTES[sub]}.</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          In October 2026 the codebook was revised and every item since 2019 was re-summarized under it: a Budget,
          finance &amp; payments category was added for the district&apos;s own budget plans and payment ratifications,
          Legal, insurance &amp; risk became Legal, compliance &amp; risk, the after-school rule was tightened to what the
          text says, and the special education sub-categories were added. The data repository&apos;s README has the
          details and the before-and-after counts.
        </p>
```

Also update the existing paragraph in "Categories and action types" (line ~104) to mention the sub-category: "…assigns each item one category (see Categories), a sub-category when the category is Special education, and one action type…".

- [ ] **Step 4: Type-check (a full build has to wait for the data)**

The site's fetch script (`scripts/fetch-consent-data.mjs`) only reads `.tar.gz` archives of the data repo (`CONSENT_DATA_ARCHIVES`), and the live archives are still schema 1, so `next build` fails on the version gate until Task 11 pushes the data. Check what can be checked now:

```bash
npm run lint
```

Expected: `tsc --noEmit` clean. The `Record<TCategory, …>` label maps come from the schema package, so a missing entry would show here. The rendering check (13 categories and the sub-category table on the about page) happens on the deploy in Task 11.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A && git commit -m "consent: accept data schema 2 (codebook v5), sub-category table on the about page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin consent-schema-2
gh pr create --title "Consent Tracker: accept data schema 2 (codebook v5)" --body "Lockstep change for oakvs/ousd-consent-data codebook v5: SUPPORTED_SCHEMA_MAJOR 2, renamed legal color key, new budget category color, special-ed sub-category table and re-categorization note on the about page. Merge before the data repo's codebook-v5 branch is pushed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Then `mcp__ccd_pr__get_status` and bind the PR if it isn't reported.

---

### Task 11: Merge, push, deploy, resume

- [ ] **Step 1: Site first**

Ask the user to merge the oakvs PR (or merge it with their approval). Its Vercel build will fail on the version gate ("data schemaVersion 1.0.0 doesn't match the site's supported 2.x") because the live data is still schema 1; Vercel keeps serving the previous deploy, so nothing breaks for readers. That failed build is expected and clears in Step 3. Merging the site first (rather than the data first) is deliberate: the alternative window would have schema-2 data published with no site able to build against it.

- [ ] **Step 2: Data repo**

```bash
cd /Users/oppodeldoc/code/ousd-consent
npm test && npm run type-check
git checkout main && git pull --ff-only
git merge --no-ff codebook-v5 -m "Codebook v5: revised categories, special-ed sub-categories, schema 2.0.0, full re-run

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```

If `main` moved since the branch was cut (it shouldn't, with the scheduler paused), resolve conflicts in `data/meetings.json` / `data/published/upcoming.json` by taking `main`'s versions and rebuilding.

- [ ] **Step 3: Deploy and resume**

The push triggers the mirror workflow and the deploy hook as usual. Verify the site rebuilt against schema 2 (the Vercel build log shows the fetch script accepting `2.0.0`), then ask the user to re-enable the scheduler: `gh workflow enable "consent run"` and restart the homelab standby. Watch the next scheduled run's commit: it should be a routine `upcoming:` or `registry:` commit, and any new items it enriches must carry `enrich.v5.md`.

- [ ] **Step 4: Close out**

Spot-check on the live site: a special-education item's detail page shows its sub-category once the follow-on UI lands (not yet); the meeting overview's "Spending by category" shows 13 categories including Budget, finance & payments; the about page lists the sub-categories. Note the Oct 14 agenda is due Oct 11; the scheduler must be on by then.
