/**
 * One-off: seed a meeting from the v1 prototype files.
 *
 * - raw  (`n`, `mid`, `hist` …, snake_case)  → RawSnapshot
 * - enriched (v1 prompt output)              → EnrichmentsFile (v2 camelCase)
 *     `per_unit` → `per_year`; 'ratification', 'previously_delayed',
 *     'raises_existing_contract' and 'source_issue' flags are dropped because
 *     they're derived in code now.
 * - v1 `source_issue` / `amount_verified`     → OverridesFile (these were
 *   confirmed by hand during the prototype research)
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { Enrichment, LlmFlag, RawItem, SCHEMA_VERSION } from '@oakvs/consent-schema/schema'
import type {
  TEnrichmentsFile,
  TOverride,
  TOverridesFile,
  TRawItem,
  TRawSnapshot,
} from '@oakvs/consent-schema/schema'

import { normalizeCode, normalizeVendorNo } from '../normalize/raw-item'
import { paths, writeJson } from '../store'

type TV1Raw = {
  meeting: { date: string; event_id: number }
  items: {
    n: string; seq: number; file: string; mid: number; name: string; type: string | null
    group: string | null; atts: { name: string; url: string }[]; vendor_no: string | null
    resource: string | null; funding: string | null; presenter: string | null; intro: string | null
    guid: string | null; text: string; hist: { d: string; a: string; body: string | null }[]
  }[]
}

type TV1Enriched = {
  items: {
    n: string; file: string; headline: string; summary: string; category: string; action_type: string
    vendor: { name: string | null; location: string | null } | null; schools: string[] | null
    money: {
      direction: string; amount_type: string | null; this_action: number | null; prior_total: number | null
      new_total: number | null; by_year: Record<string, number> | null; evidence: string | null
    }
    term: { start: string | null; end: string | null }
    flags: string[]; source_issue: string | null; amount_verified: boolean
  }[]
}

export const PROTOTYPE_MODEL_ID = 'prototype-v1'
export const PROTOTYPE_PROMPT_VERSION = 'enrich.v1.md'

const LLM_FLAGS = new Set<string>(LlmFlag.options)
const blank = (v: string | null | undefined): string | null => (v?.trim() ? v.trim() : null)

export function enrichmentCacheKey(text: string, title: string, promptVersion: string, modelId: string): string {
  return createHash('sha256').update(`${text}\u0000${title}\u0000${promptVersion}\u0000${modelId}`).digest('hex')
}

/** Hand-verified fixes the v1 schema couldn't express. */
const MANUAL_OVERRIDES: Record<string, Partial<TOverride>> = {
  // Zum special-ed busing: 15-year extension at $13.1M–$17.6M per year, no total stated.
  '26-1284': {
    fields: {
      money: { thisActionRange: [13_083_445, 17_608_594] },
      term: { start: '2020-08-01', end: '2041-06-30', addedStart: '2026-07-01' },
    },
  },
}

export async function importPrototype(
  meetingKey: string,
  rawFile: string,
  enrichedFile: string,
): Promise<{ raw: TRawSnapshot; enrichments: TEnrichmentsFile; overrides: TOverridesFile }> {
  const v1Raw = JSON.parse(await readFile(rawFile, 'utf8')) as TV1Raw
  const v1Enriched = JSON.parse(await readFile(enrichedFile, 'utf8')) as TV1Enriched

  const items: TRawItem[] = v1Raw.items.map(i => RawItem.parse({
    agendaNumber: i.n,
    agendaSequence: i.seq,
    consentSection: 'general',
    group: blank(i.group),
    file: i.file,
    matterId: i.mid,
    matterGuid: blank(i.guid),
    title: i.name.replace(/\s+/g, ' ').trim(),
    text: i.text.trim(),
    matterType: blank(i.type),
    presenter: blank(i.presenter),
    vendorNo: normalizeVendorNo(i.vendor_no),
    resourceSite: normalizeCode(i.resource),
    fundingSource: blank(i.funding),
    introDate: blank(i.intro),
    attachments: i.atts.map(a => ({ name: a.name.replace(/\s+/g, ' ').trim(), url: a.url })),
    history: i.hist.map(h => ({ date: h.d, action: h.a, body: blank(h.body), eventId: null })),
  }))
  const byFile = new Map(items.map(i => [i.file, i]))

  const enrichments: TEnrichmentsFile = { meetingKey, items: {} }
  const overrides: TOverridesFile = { meetingKey, items: {} }

  for (const e of v1Enriched.items) {
    const raw = byFile.get(e.file)
    if (!raw) throw new Error(`Enriched item ${e.n} (${e.file}) has no raw match`)
    const output = Enrichment.parse({
      headline: e.headline,
      summary: e.summary,
      category: e.category,
      actionType: e.action_type,
      vendor: { name: blank(e.vendor?.name), location: blank(e.vendor?.location) },
      schools: e.schools ?? [],
      money: {
        direction: e.money.direction,
        amountType: e.money.amount_type === 'per_unit' ? 'per_year' : e.money.amount_type,
        thisAction: e.money.this_action,
        thisActionRange: null,
        priorTotal: e.money.prior_total,
        newTotal: e.money.new_total,
        byYear: e.money.by_year ?? {},
        evidence: blank(e.money.evidence),
      },
      term: { ...e.term, addedStart: null },
      flags: e.flags.filter(f => LLM_FLAGS.has(f)),
      sourceIssueCandidate: null,
      uncertain: [],
    })
    enrichments.items[e.file] = {
      modelId: PROTOTYPE_MODEL_ID,
      promptVersion: PROTOTYPE_PROMPT_VERSION,
      cacheKey: enrichmentCacheKey(raw.text, raw.title, PROTOTYPE_PROMPT_VERSION, PROTOTYPE_MODEL_ID),
      output,
    }

    if (e.source_issue || !e.amount_verified) {
      overrides.items[e.file] = {
        fields: {},
        ...(e.source_issue ? { sourceIssue: e.source_issue } : {}),
        ...(!e.amount_verified ? { amountVerified: false } : {}),
        reviewer: 'prototype research',
        reviewedAt: null,
        note: null,
      }
    }
  }

  for (const [file, manual] of Object.entries(MANUAL_OVERRIDES)) {
    const existing = overrides.items[file] ?? { fields: {}, reviewer: 'prototype research', reviewedAt: null, note: null }
    overrides.items[file] = { ...existing, ...manual, fields: { ...existing.fields, ...manual.fields } }
  }

  const raw: TRawSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    meetingKey,
    eventId: v1Raw.meeting.event_id,
    fetchedAt: '2026-06-21T00:00:00.000Z',
    source: 'prototype',
    consentVotes: [],
    items,
  }

  await writeJson(paths.raw(meetingKey), raw)
  await writeJson(paths.enrichments(meetingKey), enrichments)
  await writeJson(paths.overrides(meetingKey), overrides)
  // The v1 meeting note is deliberately not imported: Legistar histories show
  // the report WAS adopted June 24, with ~18 pulled items decided June 29.
  return { raw, enrichments, overrides }
}
